import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorizedResponse } from "@/lib/auth";
import { ingestAnnualFilings } from "@/lib/parseAnnualFiling";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorJson(error: string, detail: string | undefined, status: number) {
  return NextResponse.json({ error, detail } satisfies ApiError, { status });
}

/**
 * POST /api/filings/annual?ticker=TICKER
 *
 * Fetches the last 4 10-Q and 2 10-K filings for the ticker from EDGAR,
 * extracts MD&A excerpts, and upserts them into the `annual_filings` table.
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorizedResponse();

  const ticker = new URL(req.url).searchParams.get("ticker")?.trim().toUpperCase();
  if (!ticker) {
    return errorJson("Missing required query param 'ticker'", undefined, 400);
  }

  let ingested: number;
  try {
    ingested = await ingestAnnualFilings(ticker);
  } catch (err) {
    return errorJson(
      "Annual filing ingest failed",
      err instanceof Error ? err.message : "Unknown error",
      502
    );
  }

  return NextResponse.json({ ticker, ingested });
}
