import { NextRequest, NextResponse } from "next/server";
import {
  searchAllFilings,
  searchFilings,
  secFetch,
  fetchAnnualFilingDoc,
  fetchAnnualFilings,
  type FilingResult,
  type AnnualFilingResult,
} from "@/lib/sec";
import { parseForm4 } from "@/lib/parseForm4";
import { parse8K } from "@/lib/parse8K";
import { parse13F } from "@/lib/parse13F";
import { parse13DG } from "@/lib/parse13DG";
import { getSupabaseClient } from "@/lib/supabase";
import {
  createJob,
  findRunningJob,
  getJob,
  advanceStep,
  updateProgress,
  completeJob,
  failJob,
  cancelJob,
  isCancelled,
  applyCancellation,
} from "@/lib/ingestJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OWNERSHIP_FORM_TYPES = ["3", "4", "5"] as const;
const MAX_HOURS = 168; // 7 days
const MAX_HOURS_TICKER = 720; // 30 days when searching by ticker

async function parseOwnershipFiling(filing: FilingResult) {
  const res = await secFetch(filing.link);
  if (!res.ok) return null;
  const html = await res.text();

  const xmlMatches = [...html.matchAll(/href="([^"]*\.xml)"/gi)];
  const rawXmlHref = xmlMatches
    .map((m) => m[1])
    .find((href) => !href.includes("/xsl"));
  if (!rawXmlHref) return null;

  const xmlUrl = rawXmlHref.startsWith("http")
    ? rawXmlHref
    : new URL(rawXmlHref, filing.link).toString();

  return parseForm4(xmlUrl);
}

/**
 * Runs the full ingest pipeline in the background, updating job progress
 * at each step so the client can poll for status.
 *
 * Steps:
 *  0  Fetch Form 3 filings
 *  1  Fetch Form 4 filings
 *  2  Fetch Form 5 filings
 *  3  Fetch 8-K filings
 *  4  Fetch 13F-HR filings
 *  5  Parse ownership filings (3/4/5)
 *  6  Parse 8-K filings
 *  7  Parse 13F-HR filings
 *  8  Save to database
 */
async function runIngest(jobId: string, hours: number, ticker?: string) {
  const supabase = getSupabaseClient();
  const now = new Date();
  const cutoffDate = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const startDate = cutoffDate.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  // 13F filings are quarterly — use a wider window (max 90 days)
  const hours13f = Math.min(Math.max(hours, 720), 2160);
  const cutoff13f = new Date(now.getTime() - hours13f * 60 * 60 * 1000);
  const startDate13f = cutoff13f.toISOString().slice(0, 10);

  // ── Fetch phase ────────────────────────────────────────────────

  let ownershipResults: FilingResult[] = [];
  let eightKResults: FilingResult[] = [];
  let thirteenFResults: FilingResult[] = [];

  // Steps 0–2: Fetch ownership form types
  for (const formType of OWNERSHIP_FORM_TYPES) {
    if (isCancelled(jobId)) { applyCancellation(jobId); return; }
    advanceStep(jobId);
    try {
      const results = await searchAllFilings({
        formType,
        ticker,
        startDate,
        endDate,
        maxResults: 2000,
      });
      ownershipResults = ownershipResults.concat(results);
      updateProgress(
        jobId,
        results.length,
        results.length,
        `Found ${results.length} Form ${formType} filings`,
      );
    } catch (err) {
      failJob(
        jobId,
        `EDGAR fetch failed for Form ${formType}: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
      return;
    }
  }

  // Step 3: Fetch 8-K filings
  if (isCancelled(jobId)) { applyCancellation(jobId); return; }
  advanceStep(jobId);
  try {
    eightKResults = await searchAllFilings({
      formType: "8-K",
      ticker,
      startDate,
      endDate,
      maxResults: 2000,
    });
    updateProgress(
      jobId,
      eightKResults.length,
      eightKResults.length,
      `Found ${eightKResults.length} 8-K filings`,
    );
  } catch (err) {
    failJob(
      jobId,
      `EDGAR fetch failed for 8-K: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
    return;
  }

  // Step 4: Fetch 13F-HR filings
  if (isCancelled(jobId)) { applyCancellation(jobId); return; }
  advanceStep(jobId);
  try {
    thirteenFResults = await searchAllFilings({
      formType: "13F-HR",
      ticker,
      startDate: startDate13f,
      endDate,
      maxResults: 2000,
    });
    updateProgress(
      jobId,
      thirteenFResults.length,
      thirteenFResults.length,
      `Found ${thirteenFResults.length} 13F-HR filings`,
    );
  } catch (err) {
    failJob(
      jobId,
      `EDGAR fetch failed for 13F-HR: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
    return;
  }

  // Step 5: Fetch 13D/13G activist filings (combined fetch+parse)
  // Use a wider window — these are infrequent but important.
  if (isCancelled(jobId)) { applyCancellation(jobId); return; }
  advanceStep(jobId);

  type ThirteenDGRow = {
    accession_no: string;
    filing_type: string;
    filed_at: string;
    filer_name: string;
    filer_cik: string | null;
    subject_ticker: string | null;
    subject_company: string;
    percent_acquired: number | null;
    acquisition_date: string | null;
    purpose_excerpt: string;
    filing_link: string;
  };

  const thirteenDGRows: ThirteenDGRow[] = [];
  let thirteenDGFailed = 0;

  try {
    const [dResults, gResults] = await Promise.all([
      searchAllFilings({ formType: "SC 13D", ticker, startDate, endDate, maxResults: 500 })
        .catch(() => [] as FilingResult[]),
      searchAllFilings({ formType: "SC 13G", ticker, startDate, endDate, maxResults: 500 })
        .catch(() => [] as FilingResult[]),
    ]);
    const dgFilings = [...dResults, ...gResults];
    updateProgress(jobId, 0, dgFilings.length, `Found ${dgFilings.length} 13D/13G filings`);

    for (let i = 0; i < dgFilings.length; i++) {
      if (isCancelled(jobId)) { applyCancellation(jobId); return; }
      const f = dgFilings[i];
      try {
        const parsed = await parse13DG(f);
        thirteenDGRows.push({
          accession_no: parsed.accessionNo,
          filing_type: parsed.filingType,
          filed_at: parsed.filedAt,
          filer_name: parsed.filerName,
          filer_cik: parsed.filerCik,
          subject_ticker: parsed.subjectTicker,
          subject_company: parsed.subjectCompany,
          percent_acquired: parsed.percentAcquired,
          acquisition_date: parsed.acquisitionDate,
          purpose_excerpt: parsed.purposeExcerpt,
          filing_link: parsed.filingLink,
        });
      } catch {
        thirteenDGFailed++;
      }
      updateProgress(jobId, i + 1, dgFilings.length);
    }
  } catch (err) {
    updateProgress(jobId, 0, 1, `13D/13G fetch error: ${err instanceof Error ? err.message : "Unknown error"}`);
  }

  // ── Fetch + parse annual filings (Step 6) ────────────────────
  // When a ticker is given, retrieve the last 4 10-Q and 2 10-K filings.
  // For broad ingests, search within a 1-year window (capped at 50 results).

  if (isCancelled(jobId)) { applyCancellation(jobId); return; }
  advanceStep(jobId);

  const annualRows: {
    ticker: string;
    form_type: string;
    filing_date: string;
    period_of_report: string | null;
    primary_doc_url: string | null;
    mda_excerpt: string;
  }[] = [];
  let annualFailed = 0;

  try {
    let annualResults: AnnualFilingResult[];

    if (ticker) {
      annualResults = await fetchAnnualFilings(ticker);
    } else {
      // Broad ingest: search for recent 10-Q/10-K filings in a 1-year window.
      const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const [qFilings, kFilings] = await Promise.all([
        searchFilings({ formType: "10-Q", startDate: oneYearAgo, endDate, pageSize: 25 })
          .then((r) => r.results)
          .catch(() => [] as FilingResult[]),
        searchFilings({ formType: "10-K", startDate: oneYearAgo, endDate, pageSize: 25 })
          .then((r) => r.results)
          .catch(() => [] as FilingResult[]),
      ]);

      annualResults = [];
      for (const f of [...qFilings, ...kFilings]) {
        if (isCancelled(jobId)) { applyCancellation(jobId); return; }
        const tkr = f.ticker ?? "";
        if (!tkr) { annualFailed++; continue; }
        annualResults.push(await fetchAnnualFilingDoc(f, tkr));
      }
    }

    for (const r of annualResults) {
      if (!r.ticker) { annualFailed++; continue; }
      annualRows.push({
        ticker: r.ticker,
        form_type: r.formType,
        filing_date: r.filingDate,
        period_of_report: r.periodOfReport || null,
        primary_doc_url: r.primaryDocUrl,
        mda_excerpt: r.mdaExcerpt,
      });
    }

    updateProgress(
      jobId,
      annualRows.length,
      annualRows.length + annualFailed,
      `Parsed ${annualRows.length} annual filings`,
    );
  } catch (err) {
    // Non-fatal — log and continue.
    annualFailed++;
    updateProgress(jobId, 0, 1, `Annual filings fetch error: ${err instanceof Error ? err.message : "Unknown error"}`);
  }

  // ── Parse ownership filings (Step 6) ──────────────────────────

  advanceStep(jobId, `0 / ${ownershipResults.length} filings`);

  const companiesMap = new Map<
    string,
    { cik: string; name: string; ticker: string }
  >();
  const insidersMap = new Map<string, { cik: string; name: string }>();
  const relationsMap = new Map<
    string,
    {
      company_cik: string;
      insider_cik: string;
      title: string;
      relationship: string;
    }
  >();
  const txnRows: {
    accession_no: string;
    company_cik: string;
    insider_cik: string;
    filing_type: string;
    filing_url: string;
    transaction_date: string;
    transaction_type: string;
    transaction_code: string;
    shares: number;
    price_per_share: number;
    total_value: number;
    shares_owned_after: number;
    is_direct_ownership: boolean;
    filed_at: string;
  }[] = [];

  let ownershipParsed = 0;
  let ownershipFailed = 0;

  for (let i = 0; i < ownershipResults.length; i++) {
    if (isCancelled(jobId)) { applyCancellation(jobId); return; }
    const f = ownershipResults[i];
    let parsed;
    try {
      parsed = await parseOwnershipFiling(f);
    } catch {
      ownershipFailed++;
      updateProgress(jobId, i + 1, ownershipResults.length);
      continue;
    }
    if (!parsed) {
      ownershipFailed++;
      updateProgress(jobId, i + 1, ownershipResults.length);
      continue;
    }

    ownershipParsed++;
    const companyCik = parsed.issuerCik;
    const insiderCik = parsed.ownerCik;

    if (companyCik && !companiesMap.has(companyCik)) {
      companiesMap.set(companyCik, {
        cik: companyCik,
        name: parsed.issuerName,
        ticker: parsed.issuerTicker,
      });
    }

    if (insiderCik && !insidersMap.has(insiderCik)) {
      insidersMap.set(insiderCik, {
        cik: insiderCik,
        name: parsed.ownerName,
      });
    }

    if (companyCik && insiderCik) {
      const relKey = `${companyCik}:${insiderCik}`;
      relationsMap.set(relKey, {
        company_cik: companyCik,
        insider_cik: insiderCik,
        title: parsed.ownerTitle,
        relationship: parsed.ownerRelationship,
      });
    }

    for (const t of parsed.transactions) {
      if (!companyCik || !insiderCik) continue;
      txnRows.push({
        accession_no: f.accessionNo,
        company_cik: companyCik,
        insider_cik: insiderCik,
        filing_type: f.filingType,
        filing_url: f.link,
        transaction_date: t.transactionDate,
        transaction_type: t.transactionType,
        transaction_code: t.transactionCode,
        shares: t.sharesTraded,
        price_per_share: t.pricePerShare,
        total_value: t.totalValue,
        shares_owned_after: t.sharesOwnedAfter,
        is_direct_ownership: t.isDirectOwnership,
        filed_at: f.filingDate,
      });
    }

    updateProgress(jobId, i + 1, ownershipResults.length);
  }

  // ── Parse 8-K filings (Step 6) ───────────────────────────────

  advanceStep(jobId, `0 / ${eightKResults.length} filings`);

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

  const eightKRows: EventRow[] = [];
  let eightKFailed = 0;

  for (let i = 0; i < eightKResults.length; i++) {
    if (isCancelled(jobId)) { applyCancellation(jobId); return; }
    const f = eightKResults[i];
    try {
      const parsed = await parse8K(f.link, {
        filerName: f.filerName,
        ticker: f.ticker,
        cik: f.cik,
        accessionNo: f.accessionNo,
        filingDate: f.filingDate,
      });
      eightKRows.push({
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
      eightKFailed++;
    }
    updateProgress(jobId, i + 1, eightKResults.length);
  }

  // ── Parse 13F-HR filings (Step 7) ────────────────────────────

  advanceStep(jobId, `0 / ${thirteenFResults.length} filings`);

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

  const holdingRows: HoldingRow[] = [];
  let thirteenFFailed = 0;

  for (let i = 0; i < thirteenFResults.length; i++) {
    if (isCancelled(jobId)) { applyCancellation(jobId); return; }
    const f = thirteenFResults[i];
    let parsed;
    try {
      parsed = await parse13F(f.link, {
        filerName: f.filerName,
        filerCik: f.cik,
        accessionNo: f.accessionNo,
        filingDate: f.filingDate,
      });
    } catch {
      thirteenFFailed++;
      updateProgress(jobId, i + 1, thirteenFResults.length);
      continue;
    }

    if (parsed.holdings.length === 0) {
      thirteenFFailed++;
      updateProgress(jobId, i + 1, thirteenFResults.length);
      continue;
    }

    for (const h of parsed.holdings) {
      holdingRows.push({
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
        put_call: h.putCall ?? "",
      });
    }

    updateProgress(jobId, i + 1, thirteenFResults.length);
  }

  // ── Save to database (Step 9) ────────────────────────────────

  if (isCancelled(jobId)) { applyCancellation(jobId); return; }
  advanceStep(jobId, "Upserting companies");
  const BATCH = 500;
  let dbStep = 0;
  const dbTotal = 9;

  // Deduplicate rows that share the same conflict key — last write wins
  const deduped8K = [
    ...new Map(eightKRows.map((r) => [r.accession_no, r])).values(),
  ];
  const deduped13F = [
    ...new Map(
      holdingRows.map((r) => [`${r.accession_no}|${r.cusip}|${r.put_call ?? ""}`, r]),
    ).values(),
  ];
  const dedupedTxn = [
    ...new Map(
      txnRows.map((r) => [
        `${r.accession_no}|${r.transaction_date}|${r.transaction_code}|${r.shares}|${r.insider_cik}`,
        r,
      ]),
    ).values(),
  ];

  if (companiesMap.size > 0) {
    const { error } = await supabase
      .from("companies")
      .upsert([...companiesMap.values()], { onConflict: "cik" });
    if (error) {
      failJob(jobId, `Failed to upsert companies: ${error.message}`);
      return;
    }
  }
  updateProgress(jobId, ++dbStep, dbTotal, "Upserting insiders");

  if (insidersMap.size > 0) {
    const { error } = await supabase
      .from("insiders")
      .upsert([...insidersMap.values()], { onConflict: "cik" });
    if (error) {
      failJob(jobId, `Failed to upsert insiders: ${error.message}`);
      return;
    }
  }
  updateProgress(jobId, ++dbStep, dbTotal, "Upserting relationships");

  if (relationsMap.size > 0) {
    const { error } = await supabase
      .from("company_insiders")
      .upsert([...relationsMap.values()], {
        onConflict: "company_cik,insider_cik",
      });
    if (error) {
      failJob(jobId, `Failed to upsert company_insiders: ${error.message}`);
      return;
    }
  }
  updateProgress(jobId, ++dbStep, dbTotal, "Upserting transactions");

  if (dedupedTxn.length > 0) {
    for (let i = 0; i < dedupedTxn.length; i += BATCH) {
      const { error } = await supabase
        .from("transactions")
        .upsert(dedupedTxn.slice(i, i + BATCH), {
          onConflict:
            "accession_no,transaction_date,transaction_code,shares,insider_cik",
        });
      if (error) {
        failJob(jobId, `Failed to upsert transactions: ${error.message}`);
        return;
      }
    }
  }
  updateProgress(jobId, ++dbStep, dbTotal, "Upserting 8-K events");

  if (deduped8K.length > 0) {
    for (let i = 0; i < deduped8K.length; i += BATCH) {
      const { error } = await supabase
        .from("events_8k")
        .upsert(deduped8K.slice(i, i + BATCH), {
          onConflict: "accession_no",
        });
      if (error) {
        failJob(jobId, `Failed to upsert events_8k: ${error.message}`);
        return;
      }
    }
  }
  updateProgress(jobId, ++dbStep, dbTotal, "Upserting 13F holdings");

  if (deduped13F.length > 0) {
    for (let i = 0; i < deduped13F.length; i += BATCH) {
      const { error } = await supabase
        .from("holdings_13f")
        .upsert(deduped13F.slice(i, i + BATCH), {
          onConflict: "accession_no,cusip,put_call",
          ignoreDuplicates: false,
        });
      if (error) {
        failJob(jobId, `Failed to upsert holdings_13f: ${error.message}`);
        return;
      }
    }
  }
  updateProgress(jobId, ++dbStep, dbTotal, "Upserting 13D/13G filings");

  const dedupedThirteenDG = [
    ...new Map(thirteenDGRows.map((r) => [r.accession_no, r])).values(),
  ];

  if (dedupedThirteenDG.length > 0) {
    for (let i = 0; i < dedupedThirteenDG.length; i += BATCH) {
      const { error } = await supabase
        .from("thirteen_dg_filings")
        .upsert(dedupedThirteenDG.slice(i, i + BATCH), {
          onConflict: "accession_no",
        });
      if (error) {
        failJob(jobId, `Failed to upsert thirteen_dg_filings: ${error.message}`);
        return;
      }
    }
  }
  updateProgress(jobId, ++dbStep, dbTotal, "Upserting annual filings");

  const dedupedAnnual = [
    ...new Map(
      annualRows.map((r) => [`${r.ticker}|${r.form_type}|${r.filing_date}`, r])
    ).values(),
  ];

  if (dedupedAnnual.length > 0) {
    for (let i = 0; i < dedupedAnnual.length; i += BATCH) {
      const { error } = await supabase
        .from("annual_filings")
        .upsert(dedupedAnnual.slice(i, i + BATCH), {
          onConflict: "ticker,form_type,filing_date",
        });
      if (error) {
        failJob(jobId, `Failed to upsert annual_filings: ${error.message}`);
        return;
      }
    }
  }
  updateProgress(jobId, ++dbStep, dbTotal, "Done");

  completeJob(jobId, {
    ticker: ticker ?? null,
    ownershipParsed,
    ownershipFailed,
    companies: companiesMap.size,
    insiders: insidersMap.size,
    transactions: dedupedTxn.length,
    eightKEvents: deduped8K.length,
    eightKFailed,
    thirteenFHoldings: deduped13F.length,
    thirteenFFailed,
    thirteenDGFilings: dedupedThirteenDG.length,
    thirteenDGFailed,
    annualFilings: dedupedAnnual.length,
    annualFailed,
    totalFilingsFetched:
      ownershipResults.length + eightKResults.length + thirteenFResults.length,
  });
}

/**
 * GET /api/filings/ingest?jobId=xxx
 *
 * Poll for ingestion job status. If no jobId is provided, returns
 * any currently running job (so the client can reconnect after refresh).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");

  if (!jobId) {
    const running = findRunningJob();
    if (running) return NextResponse.json(running);
    return NextResponse.json({ status: "idle" });
  }

  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  return NextResponse.json(job);
}

/**
 * POST /api/filings/ingest?hours=24
 *
 * Starts a background ingestion job. Returns immediately with a jobId.
 * The work continues server-side even if the client disconnects.
 * Poll GET /api/filings/ingest?jobId=xxx for progress.
 */
export async function POST(req: NextRequest) {
  // Prevent concurrent ingests
  const existing = findRunningJob();
  if (existing) {
    return NextResponse.json({ jobId: existing.id });
  }

  const { searchParams } = new URL(req.url);
  const ticker = searchParams.get("ticker")?.trim().toUpperCase() || undefined;
  const maxHours = ticker ? MAX_HOURS_TICKER : MAX_HOURS;
  const defaultHours = ticker ? 720 : 24;
  const hours = Math.min(
    Math.max(parseInt(searchParams.get("hours") ?? String(defaultHours), 10) || defaultHours, 1),
    maxHours,
  );

  const jobId = crypto.randomUUID();
  const tickerLabel = ticker ? ` for ${ticker}` : "";
  createJob(jobId, [
    `Fetching Form 3 filings${tickerLabel}`,
    `Fetching Form 4 filings${tickerLabel}`,
    `Fetching Form 5 filings${tickerLabel}`,
    `Fetching 8-K filings${tickerLabel}`,
    `Fetching 13F-HR filings${tickerLabel}`,
    `Fetching 13D/13G activist filings${tickerLabel}`,
    `Fetching annual filings (10-Q/10-K)${tickerLabel}`,
    "Parsing ownership XML",
    "Parsing 8-K filings",
    "Parsing 13F-HR filings",
    "Saving to database",
  ]);

  // Fire and forget — work continues after response is sent
  runIngest(jobId, hours, ticker).catch((err) => {
    failJob(jobId, err instanceof Error ? err.message : "Unexpected error");
  });

  return NextResponse.json({ jobId });
}

/**
 * DELETE /api/filings/ingest
 *
 * Cancel the currently running ingestion job.
 */
export async function DELETE() {
  const running = findRunningJob();
  if (!running) {
    return NextResponse.json({ error: "No running job to cancel" }, { status: 404 });
  }
  const ok = cancelJob(running.id);
  if (!ok) {
    return NextResponse.json({ error: "Job already finished" }, { status: 409 });
  }
  return NextResponse.json({ cancelled: true, jobId: running.id });
}