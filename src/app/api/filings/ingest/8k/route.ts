import { NextRequest, NextResponse } from "next/server";
import { searchAllFilings, type FilingResult } from "@/lib/sec";
import { parse8K } from "@/lib/parse8K";
import { getSupabaseClient } from "@/lib/supabase";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_HOURS = 168; // 7 days

function errorJson(error: string, detail: string | undefined, status: number) {
  return NextResponse.json({ error, detail } satisfies ApiError, { status });
}

/**
 * POST /api/filings/ingest/8k?hours=24
 *
 * Fetches recent 8-K filings from EDGAR, extracts reported item numbers and
 * a plain-text excerpt from each primary document, and upserts into events_8k.
 */
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const hours = Math.min(
    Math.max(parseInt(searchParams.get("hours") ?? "24", 10) || 24, 1),
    MAX_HOURS,
  );

  const now = new Date();
  const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const startDate = cutoff.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  let filings: FilingResult[];
  try {
    filings = await searchAllFilings({
      formType: "8-K",
      startDate,
      endDate,
      maxResults: 2000,
    });
  } catch (err) {
    return errorJson(
      "EDGAR fetch failed for 8-K",
      err instanceof Error ? err.message : "Unknown error",
      502,
    );
  }

  if (filings.length === 0) {
    return NextResponse.json({
      ingested: 0,
      message: `No 8-K filings found in the last ${hours} hour(s).`,
    });
  }

  const supabase = getSupabaseClient();

  type EventRow = {
    accession_no: string;
    company_cik: string | null;
    filer_name: string;
    ticker: string | null;
    filing_date: string;
    items: string[];
    primary_doc_url: string | null;
    text_excerpt: string;
  };

  const rows: EventRow[] = [];
  let failedCount = 0;

  for (const f of filings) {
    try {
      const parsed = await parse8K(f.link, {
        filerName: f.filerName,
        ticker: f.ticker,
        cik: f.cik,
        accessionNo: f.accessionNo,
        filingDate: f.filingDate,
      });

      rows.push({
        accession_no: parsed.accessionNo,
        company_cik: parsed.cik,
        filer_name: parsed.filerName,
        ticker: parsed.ticker,
        filing_date: parsed.filingDate,
        items: parsed.items,
        primary_doc_url: parsed.primaryDocUrl,
        text_excerpt: parsed.textExcerpt,
      });
    } catch {
      failedCount++;
    }
  }

  if (rows.length === 0) {
    return NextResponse.json({
      ingested: 0,
      failed: failedCount,
      message: "All filings failed to parse.",
    });
  }

  // Upsert in batches of 500 to stay within Supabase payload limits
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase
      .from("events_8k")
      .upsert(rows.slice(i, i + BATCH), { onConflict: "accession_no" });
    if (error) return errorJson("Failed to upsert events_8k", error.message, 500);
  }

  return NextResponse.json({
    ingested: rows.length,
    failed: failedCount,
  });
}
