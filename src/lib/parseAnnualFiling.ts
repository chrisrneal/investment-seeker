// Ingest 10-Q / 10-K filings for a ticker into the `annual_filings` table.
// Uses the fetchAnnualFilings() function from sec.ts which handles all the
// EDGAR fetching, MD&A extraction, and rate-limiting.

import { fetchAnnualFilings } from "./sec";
import { getSupabaseClient } from "./supabase";

/**
 * Fetch the last 4 10-Q and 2 10-K filings for `ticker` from EDGAR,
 * extract MD&A excerpts, and upsert them into the `annual_filings` table.
 *
 * Returns the number of rows successfully upserted.
 */
export async function ingestAnnualFilings(ticker: string): Promise<number> {
  const tickerUpper = ticker.toUpperCase();
  const results = await fetchAnnualFilings(tickerUpper);

  if (results.length === 0) return 0;

  const supabase = getSupabaseClient();
  let upserted = 0;

  for (const r of results) {
    // Skip filings where we couldn't extract any useful content.
    if (!r.primaryDocUrl && !r.mdaExcerpt) continue;

    const { error } = await supabase.from("annual_filings").upsert(
      {
        ticker: r.ticker,
        form_type: r.formType,
        filing_date: r.filingDate || new Date().toISOString().slice(0, 10),
        period_of_report: r.periodOfReport || null,
        primary_doc_url: r.primaryDocUrl || null,
        mda_excerpt: r.mdaExcerpt || "",
      },
      { onConflict: "ticker,form_type,filing_date" }
    );

    if (!error) upserted++;
  }

  return upserted;
}
