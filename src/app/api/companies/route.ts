import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { getAuthUser, unauthorizedResponse } from "@/lib/auth";
import type { ApiError } from "@/lib/types";
import { fetchShortInterest } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorJson(error: string, detail: string | undefined, status: number) {
  return NextResponse.json({ error, detail } satisfies ApiError, { status });
}

/**
 * GET /api/companies?limit=50
 *
 * Returns companies ordered by most recent transaction date.
 * Each company includes its insiders and their recent transactions.
 */
export async function GET(req: NextRequest) {
  // ── Auth gate ──
  const user = await getAuthUser(req);
  if (!user) return unauthorizedResponse();

  const { searchParams } = new URL(req.url);
  const limit = Math.min(
    Math.max(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 1),
    200,
  );

  const supabase = getSupabaseClient();

  // Supabase type helpers (table doesn't exist in generated types yet)
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

  type DbResult<T> = { data: T[] | null; error: { message: string } | null };

  // Get companies ordered by latest activity
  const { data: companies, error: compErr } = await supabase
    .from("companies")
    .select("cik, name, ticker, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit) as DbResult<CompanyRow>;

  if (compErr) return errorJson("Failed to query companies", compErr.message, 500);
  if (!companies || companies.length === 0) {
    return NextResponse.json({ count: 0, companies: [] });
  }

  const ciks = companies.map((c) => c.cik);

  // Fetch insiders for these companies
  const { data: relations, error: relErr } = await supabase
    .from("company_insiders")
    .select("company_cik, insider_cik, title, relationship")
    .in("company_cik", ciks) as DbResult<RelationRow>;

  if (relErr) return errorJson("Failed to query company_insiders", relErr.message, 500);

  const insiderCiks = [...new Set((relations ?? []).map((r) => r.insider_cik))];

  const { data: insiders, error: insErr }: DbResult<InsiderRow> = insiderCiks.length > 0
    ? await supabase.from("insiders").select("cik, name").in("cik", insiderCiks) as DbResult<InsiderRow>
    : { data: [], error: null };

  if (insErr) return errorJson("Failed to query insiders", insErr.message, 500);

  const insiderMap = new Map((insiders ?? []).map((i) => [i.cik, i.name]));

  // Fetch recent transactions for these companies
  const { data: txns, error: txErr } = await supabase
    .from("transactions")
    .select(
      "id, company_cik, insider_cik, filing_type, filing_url, transaction_date, " +
      "transaction_type, transaction_code, shares, price_per_share, total_value, " +
      "shares_owned_after, is_direct_ownership, filed_at",
    )
    .in("company_cik", ciks)
    .order("transaction_date", { ascending: false })
    .limit(1000) as DbResult<TxnRow>;

  if (txErr) return errorJson("Failed to query transactions", txErr.message, 500);

  // Fetch 8-K events
  const { data: eightKs, error: eightKErr } = await supabase
    .from("events_8k")
    .select("accession_no, company_cik, filer_name, ticker, filing_date, items, primary_doc_url, text_excerpt")
    .in("company_cik", ciks)
    .order("filing_date", { ascending: false })
    .limit(500) as DbResult<EightKRow>;

  if (eightKErr) return errorJson("Failed to query 8-K events", eightKErr.message, 500);

  // Fetch 13F holdings
  // We want to match holdings WHERE the company is the issuer being held.
  // The 'company_name' in holdings_13f approximately matches the tracked company name.
  // The most robust way is to query all recent holdings and filter them, or since Supabase
  // doesn't support complex JOINs easily here without a cusip mapping, we can try to find holdings
  // where the 'company_name' matches the issuer's name or ticker roughly.
  // However, there is no direct link between companies.cik and holdings_13f in this schema except company_name.
  // For simplicity since there's no cusip mapping table, we will fetch recent holdings
  // and match them in memory by company name substring.
  const { data: thirteenFs, error: thirteenFErr } = await supabase
    .from("holdings_13f")
    .select("id, accession_no, filer_cik, filer_name, period_of_report, filing_date, cusip, company_name, value_usd, shares, investment_discretion, put_call")
    .order("filing_date", { ascending: false })
    .limit(2000) as DbResult<ThirteenFRow>;

  if (thirteenFErr) return errorJson("Failed to query 13F holdings", thirteenFErr.message, 500);

  // ── Fetch short interest for all tickers in parallel ──
  const tickersWithData = companies
    .map((c) => c.ticker)
    .filter((t): t is string => !!t);

  const siResults = await Promise.allSettled(
    tickersWithData.map((t) => fetchShortInterest(t))
  );
  const shortInterestByTicker = new Map<string, { shortPercentOfFloat: number | null; shortRatio: number | null } | null>();
  tickersWithData.forEach((t, i) => {
    const r = siResults[i];
    const si = r.status === "fulfilled" ? r.value : null;
    shortInterestByTicker.set(t, si ? { shortPercentOfFloat: si.shortPercentOfFloat, shortRatio: si.shortRatio } : null);
  });

  // ── Fetch cached summaries for all filing URLs ──
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
    // Supabase .in() has a limit — batch into chunks of 200
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
        console.warn("[companies] summary query failed:", sumErr.message);
        // Fallback: query without newer columns that may not exist yet
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
    console.log(`[companies] found ${allSummaries.length} cached summaries for ${filingUrls.length} filing URLs`);
  }

  // ── Pre-group relations and transactions for O(N+M) assembly ──

  // Group relations by company_cik
  const relationsByCompany = new Map<string, RelationRow[]>();
  for (const rel of relations ?? []) {
    const list = relationsByCompany.get(rel.company_cik) ?? [];
    list.push(rel);
    relationsByCompany.set(rel.company_cik, list);
  }

  // Group transactions by company_cik AND insider_cik
  // company_cik -> insider_cik -> TxnRow[]
  const txnsByCompanyAndInsider = new Map<string, Map<string, TxnRow[]>>();
  // Also need transactions by company_cik for latestTxnDate
  const txnsByCompany = new Map<string, TxnRow[]>();

  for (const txn of txns ?? []) {
    // By company
    const cList = txnsByCompany.get(txn.company_cik) ?? [];
    cList.push(txn);
    txnsByCompany.set(txn.company_cik, cList);

    // By company and insider
    let companyMap = txnsByCompanyAndInsider.get(txn.company_cik);
    if (!companyMap) {
      companyMap = new Map<string, TxnRow[]>();
      txnsByCompanyAndInsider.set(txn.company_cik, companyMap);
    }
    const iList = companyMap.get(txn.insider_cik) ?? [];
    iList.push(txn);
    companyMap.set(txn.insider_cik, iList);
  }

  // Group 8-K events by company_cik
  const eightKsByCompany = new Map<string, EightKRow[]>();
  for (const event of eightKs ?? []) {
    const list = eightKsByCompany.get(event.company_cik) ?? [];
    list.push(event);
    eightKsByCompany.set(event.company_cik, list);
  }

  // Group 13F holdings by company matching
  const thirteenFsByCompany = new Map<string, ThirteenFRow[]>();
  for (const holding of thirteenFs ?? []) {
    // Find matching companies based on holding.company_name
    const holdingName = holding.company_name.toUpperCase();
    for (const company of companies) {
      if (holdingName.includes(company.name.toUpperCase().split(' ')[0]) ||
          (company.ticker && holdingName.includes(company.ticker.toUpperCase()))) {
        const list = thirteenFsByCompany.get(company.cik) ?? [];
        list.push(holding);
        thirteenFsByCompany.set(company.cik, list);
      }
    }
  }

  // Assemble: company → insiders (with their transactions) + 8k + 13f
  const result = companies.map((company) => {
    const companyRelations = relationsByCompany.get(company.cik) ?? [];
    const companyTxns = txnsByCompany.get(company.cik) ?? [];
    const insiderTxnsMap = txnsByCompanyAndInsider.get(company.cik);
    const companyEightKs = eightKsByCompany.get(company.cik) ?? [];
    const companyThirteenFs = thirteenFsByCompany.get(company.cik) ?? [];

    const insidersWithTxns = companyRelations.map((rel) => {
      const insiderTxnsRaw = insiderTxnsMap?.get(rel.insider_cik) ?? [];
      const insiderTxns = insiderTxnsRaw.map((t) => ({
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

    // Sort insiders by most recent transaction
    insidersWithTxns.sort((a, b) => {
      const aDate = a.transactions[0]?.transactionDate ?? "";
      const bDate = b.transactions[0]?.transactionDate ?? "";
      return bDate.localeCompare(aDate);
    });

    // Compute latest transaction date for the company
    const latestTxnDate = companyTxns[0]?.transaction_date ?? null;

    return {
      cik: company.cik,
      name: company.name,
      ticker: company.ticker,
      latestTransactionDate: latestTxnDate,
      insiders: insidersWithTxns,
      eightKEvents: companyEightKs.map((e) => ({
        accessionNo: e.accession_no,
        filingDate: e.filing_date,
        items: e.items,
        primaryDocUrl: e.primary_doc_url,
        textExcerpt: e.text_excerpt,
      })),
      thirteenFHoldings: companyThirteenFs.map((h) => ({
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
      shortInterest: company.ticker
        ? (shortInterestByTicker.get(company.ticker) ?? null)
        : null,
    };
  });

  // Sort companies by latest transaction date
  result.sort((a, b) => {
    const aDate = a.latestTransactionDate ?? "";
    const bDate = b.latestTransactionDate ?? "";
    return bDate.localeCompare(aDate);
  });

  // Build summaries dict keyed by filing URL (camelCase for frontend)
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

  return NextResponse.json({ count: result.length, companies: result, summaries });
}
