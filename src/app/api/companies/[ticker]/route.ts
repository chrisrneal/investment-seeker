import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { getAuthUser, unauthorizedResponse } from "@/lib/auth";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorJson(error: string, detail: string | undefined, status: number) {
  return NextResponse.json({ error, detail } satisfies ApiError, { status });
}

/**
 * GET /api/companies/[ticker]
 *
 * **Requires authentication.** Returns a single company by ticker symbol
 * with its insiders, transactions, 8-K events, 13F holdings, and cached
 * AI summaries. Returns 404 if the ticker is not found.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  // ── Auth gate ──
  const user = await getAuthUser(req);
  if (!user) return unauthorizedResponse();

  const { ticker } = await params;
  const tickerUpper = ticker.toUpperCase();

  const supabase = getSupabaseClient();

  // Supabase type helpers
  type CompanyRow = { cik: string; name: string; ticker: string | null; updated_at: string };
  type RelationRow = { company_cik: string; insider_cik: string; title: string | null; relationship: string | null };
  type InsiderRow = { cik: string; name: string };
  type TxnRow = {
    id: number; company_cik: string; insider_cik: string; filing_type: string;
    filing_url: string; transaction_date: string; transaction_type: string;
    transaction_code: string | null; shares: number; price_per_share: number;
    total_value: number; shares_owned_after: number; is_direct_ownership: boolean;
    filed_at: string;
  };
  type EightKRow = {
    accession_no: string; company_cik: string; filer_name: string;
    ticker: string | null; filing_date: string; items: string[];
    primary_doc_url: string | null; text_excerpt: string;
  };
  type ThirteenFRow = {
    id: number; accession_no: string; filer_cik: string;
    filer_name: string; period_of_report: string; filing_date: string;
    cusip: string; company_name: string; value_usd: number;
    shares: number; investment_discretion: string | null; put_call: string | null;
  };
  type ThirteenDGRow = {
    id: number; accession_no: string; filing_type: string; filed_at: string;
    filer_name: string; filer_cik: string | null; subject_ticker: string | null;
    subject_company: string; percent_acquired: number | null;
    acquisition_date: string | null; purpose_excerpt: string; filing_link: string | null;
  };
  type DbResult<T> = { data: T[] | null; error: { message: string } | null };

  // Find company by ticker (case-insensitive)
  const { data: companies, error: compErr } = await supabase
    .from("companies")
    .select("cik, name, ticker, updated_at")
    .ilike("ticker", tickerUpper)
    .limit(1) as DbResult<CompanyRow>;

  if (compErr) return errorJson("Failed to query companies", compErr.message, 500);
  if (!companies || companies.length === 0) {
    return errorJson("Company not found", `No company with ticker "${tickerUpper}" exists.`, 404);
  }

  const company = companies[0];
  const cik = company.cik;

  // Fetch insiders
  const { data: relations, error: relErr } = await supabase
    .from("company_insiders")
    .select("company_cik, insider_cik, title, relationship")
    .eq("company_cik", cik) as DbResult<RelationRow>;

  if (relErr) return errorJson("Failed to query company_insiders", relErr.message, 500);

  const insiderCiks = [...new Set((relations ?? []).map((r) => r.insider_cik))];

  const { data: insiders, error: insErr }: DbResult<InsiderRow> = insiderCiks.length > 0
    ? await supabase.from("insiders").select("cik, name").in("cik", insiderCiks) as DbResult<InsiderRow>
    : { data: [], error: null };

  if (insErr) return errorJson("Failed to query insiders", insErr.message, 500);

  const insiderMap = new Map((insiders ?? []).map((i) => [i.cik, i.name]));

  // Fetch transactions
  const { data: txns, error: txErr } = await supabase
    .from("transactions")
    .select(
      "id, company_cik, insider_cik, filing_type, filing_url, transaction_date, " +
      "transaction_type, transaction_code, shares, price_per_share, total_value, " +
      "shares_owned_after, is_direct_ownership, filed_at",
    )
    .eq("company_cik", cik)
    .order("transaction_date", { ascending: false })
    .limit(1000) as DbResult<TxnRow>;

  if (txErr) return errorJson("Failed to query transactions", txErr.message, 500);

  // Fetch 8-K events
  const { data: eightKs, error: eightKErr } = await supabase
    .from("events_8k")
    .select("accession_no, company_cik, filer_name, ticker, filing_date, items, primary_doc_url, text_excerpt")
    .eq("company_cik", cik)
    .order("filing_date", { ascending: false })
    .limit(500) as DbResult<EightKRow>;

  if (eightKErr) return errorJson("Failed to query 8-K events", eightKErr.message, 500);

  // Fetch 13F holdings matching this company
  const { data: thirteenFs, error: thirteenFErr } = await supabase
    .from("holdings_13f")
    .select("id, accession_no, filer_cik, filer_name, period_of_report, filing_date, cusip, company_name, value_usd, shares, investment_discretion, put_call")
    .order("filing_date", { ascending: false })
    .limit(2000) as DbResult<ThirteenFRow>;

  if (thirteenFErr) return errorJson("Failed to query 13F holdings", thirteenFErr.message, 500);

  // Filter 13F holdings by company name/ticker match
  const matchedThirteenFs = (thirteenFs ?? []).filter((h) => {
    const holdingName = h.company_name.toUpperCase();
    return (
      holdingName.includes(company.name.toUpperCase().split(" ")[0]) ||
      (company.ticker && holdingName.includes(company.ticker.toUpperCase()))
    );
  });

  // Fetch 13D/13G activist filings for this ticker
  const { data: thirteenDGs, error: thirteenDGErr } = await supabase
    .from("thirteen_dg_filings")
    .select("id, accession_no, filing_type, filed_at, filer_name, filer_cik, subject_ticker, subject_company, percent_acquired, acquisition_date, purpose_excerpt, filing_link")
    .ilike("subject_ticker", tickerUpper)
    .order("filed_at", { ascending: false })
    .limit(200) as DbResult<ThirteenDGRow>;

  if (thirteenDGErr) return errorJson("Failed to query 13D/13G filings", thirteenDGErr.message, 500);

  // ── Fetch cached summaries ──
  const filingUrls = [...new Set((txns ?? []).map((t) => t.filing_url))];

  type SummaryRow = {
    filing_url: string; deep_analysis: boolean; summary: string;
    impact_rating: string; flags: string[]; ticker: string | null;
    issuer_name: string | null; filing_type: string | null;
    transactions: unknown[]; model_used: string; estimated_cost: number;
  };
  type LegacySummaryRow = {
    filing_url: string; deep_analysis: boolean; summary: string;
    impact_rating: string; flags: string[]; model_used: string; estimated_cost: number;
  };
  type SummaryResult = { data: SummaryRow[] | null; error: { message: string } | null };
  type LegacySummaryResult = { data: LegacySummaryRow[] | null; error: { message: string } | null };

  let summaryMap: Record<string, SummaryRow> = {};

  if (filingUrls.length > 0) {
    const CHUNK = 200;
    const allSummaries: SummaryRow[] = [];
    for (let i = 0; i < filingUrls.length; i += CHUNK) {
      const chunk = filingUrls.slice(i, i + CHUNK);
      const { data: sumRows, error: sumErr } = await supabase
        .from("filing_summaries")
        .select(
          "filing_url, deep_analysis, summary, impact_rating, flags, ticker, " +
          "issuer_name, filing_type, transactions, model_used, estimated_cost",
        )
        .in("filing_url", chunk)
        .eq("deep_analysis", false) as SummaryResult;
      if (!sumErr && sumRows) {
        allSummaries.push(...sumRows);
      } else if (sumErr) {
        const { data: legacyRows, error: legacyErr } = await supabase
          .from("filing_summaries")
          .select(
            "filing_url, deep_analysis, summary, impact_rating, flags, model_used, estimated_cost",
          )
          .in("filing_url", chunk)
          .eq("deep_analysis", false) as LegacySummaryResult;
        if (!legacyErr && legacyRows) {
          allSummaries.push(...legacyRows.map((r) => ({
            ...r,
            ticker: null,
            issuer_name: null,
            filing_type: null,
            transactions: [] as unknown[],
          })));
        }
      }
    }
    for (const s of allSummaries) {
      summaryMap[s.filing_url] = s;
    }
  }

  // ── Assemble response ──
  // Group transactions by insider
  const txnsByInsider = new Map<string, TxnRow[]>();
  for (const txn of txns ?? []) {
    const list = txnsByInsider.get(txn.insider_cik) ?? [];
    list.push(txn);
    txnsByInsider.set(txn.insider_cik, list);
  }

  const insidersWithTxns = (relations ?? []).map((rel) => {
    const insiderTxns = (txnsByInsider.get(rel.insider_cik) ?? []).map((t) => ({
      id: t.id,
      filingType: t.filing_type,
      filingUrl: t.filing_url,
      transactionDate: t.transaction_date,
      transactionType: t.transaction_type,
      transactionCode: t.transaction_code,
      shares: t.shares,
      pricePerShare: t.price_per_share,
      totalValue: t.total_value,
      sharesOwnedAfter: t.shares_owned_after,
      isDirectOwnership: t.is_direct_ownership,
      filedAt: t.filed_at,
    }));

    return {
      cik: rel.insider_cik,
      name: insiderMap.get(rel.insider_cik) ?? "Unknown",
      title: rel.title,
      relationship: rel.relationship,
      transactions: insiderTxns,
    };
  });

  insidersWithTxns.sort((a, b) => {
    const aDate = a.transactions[0]?.transactionDate ?? "";
    const bDate = b.transactions[0]?.transactionDate ?? "";
    return bDate.localeCompare(aDate);
  });

  const latestTxnDate = (txns ?? [])[0]?.transaction_date ?? null;

  const result = {
    cik: company.cik,
    name: company.name,
    ticker: company.ticker,
    latestTransactionDate: latestTxnDate,
    insiders: insidersWithTxns,
    eightKEvents: (eightKs ?? []).map((e) => ({
      accessionNo: e.accession_no,
      filingDate: e.filing_date,
      items: e.items,
      primaryDocUrl: e.primary_doc_url,
      textExcerpt: e.text_excerpt,
    })),
    thirteenFHoldings: matchedThirteenFs.map((h) => ({
      id: h.id,
      accessionNo: h.accession_no,
      periodOfReport: h.period_of_report,
      filingDate: h.filing_date,
      cusip: h.cusip,
      companyName: h.company_name,
      valueUsd: h.value_usd,
      shares: h.shares,
      putCall: h.put_call,
    })),
    thirteenDGFilings: (thirteenDGs ?? []).map((f) => ({
      id: f.id,
      accessionNo: f.accession_no,
      filingType: f.filing_type,
      filedAt: f.filed_at,
      filerName: f.filer_name,
      percentAcquired: f.percent_acquired,
      acquisitionDate: f.acquisition_date,
      purposeExcerpt: f.purpose_excerpt,
      filingLink: f.filing_link,
    })),
  };

  // Build summaries dict
  const summaries: Record<string, {
    summary: string; impactRating: string; flags: string[];
    ticker: string | null; issuerName: string | null; filingType: string | null;
    transactions: unknown[]; modelUsed: string; estimatedCost: number; cached: boolean;
  }> = {};
  for (const [url, s] of Object.entries(summaryMap)) {
    summaries[url] = {
      summary: s.summary,
      impactRating: s.impact_rating,
      flags: s.flags ?? [],
      ticker: s.ticker,
      issuerName: s.issuer_name,
      filingType: s.filing_type,
      transactions: s.transactions ?? [],
      modelUsed: s.model_used,
      estimatedCost: s.estimated_cost,
      cached: true,
    };
  }

  return NextResponse.json({ company: result, summaries });
}
