import { NextRequest, NextResponse } from "next/server";
import { searchAllFilings, type FilingResult } from "@/lib/sec";
import { parse13F } from "@/lib/parse13F";
import { getSupabaseClient } from "@/lib/supabase";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_HOURS = 2160; // 90 days — 13F filings are quarterly

function errorJson(error: string, detail: string | undefined, status: number) {
  return NextResponse.json({ error, detail } satisfies ApiError, { status });
}

/**
 * POST /api/filings/ingest/13f?hours=720
 *
 * Fetches recent 13F-HR filings from EDGAR, parses the XML information table
 * for each, and upserts filer metadata + holdings into holdings_13f.
 *
 * Because 13F filings are quarterly, the default lookback window is 720 hours
 * (30 days). The maximum is 2160 hours (90 days, one full quarter).
 */
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const hours = Math.min(
    Math.max(parseInt(searchParams.get("hours") ?? "720", 10) || 720, 1),
    MAX_HOURS,
  );

  const now = new Date();
  const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const startDate = cutoff.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  let filings: FilingResult[];
  try {
    filings = await searchAllFilings({
      formType: "13F-HR",
      startDate,
      endDate,
      maxResults: 2000,
    });
  } catch (err) {
    return errorJson(
      "EDGAR fetch failed for 13F-HR",
      err instanceof Error ? err.message : "Unknown error",
      502,
    );
  }

  if (filings.length === 0) {
    return NextResponse.json({
      ingested: 0,
      message: `No 13F-HR filings found in the last ${hours} hour(s).`,
    });
  }

  const supabase = getSupabaseClient();

  type HoldingRow = {
    accession_no: string;
    filer_cik: string | null;
    filer_name: string;
    period_of_report: string;
    filing_date: string;
    cusip: string;
    company_name: string;
    value_usd: number;
    shares: number;
    investment_discretion: string;
    put_call: string | null;
  };

  const allRows: HoldingRow[] = [];
  let failedCount = 0;

  for (const f of filings) {
    let parsed;
    try {
      parsed = await parse13F(f.link, {
        filerName: f.filerName,
        filerCik: f.cik,
        accessionNo: f.accessionNo,
        filingDate: f.filingDate,
      });
    } catch {
      failedCount++;
      continue;
    }

    if (parsed.holdings.length === 0) {
      failedCount++;
      continue;
    }

    for (const h of parsed.holdings) {
      allRows.push({
        accession_no: parsed.accessionNo,
        filer_cik: parsed.filerCik,
        filer_name: parsed.filerName,
        period_of_report: parsed.periodOfReport,
        filing_date: parsed.filingDate,
        cusip: h.cusip,
        company_name: h.nameOfIssuer,
        value_usd: h.valueUsd,
        shares: h.shares,
        investment_discretion: h.investmentDiscretion,
        put_call: h.putCall,
      });
    }
  }

  if (allRows.length === 0) {
    return NextResponse.json({
      ingested: 0,
      failed: failedCount,
      message: "No holdings parsed from any filing.",
    });
  }

  // Upsert in batches of 500
  const BATCH = 500;
  for (let i = 0; i < allRows.length; i += BATCH) {
    const { error } = await supabase
      .from("holdings_13f")
      .upsert(allRows.slice(i, i + BATCH), {
        onConflict: "accession_no,cusip,put_call",
      });
    if (error) return errorJson("Failed to upsert holdings_13f", error.message, 500);
  }

  return NextResponse.json({
    ingested: allRows.length,
    failed: failedCount,
    filings: filings.length - failedCount,
  });
}
