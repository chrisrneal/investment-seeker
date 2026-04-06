import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import type { ApiError } from "@/lib/types";

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

  // Assemble: company → insiders (with their transactions)
  const result = companies.map((company) => {
    const companyRelations = (relations ?? []).filter(
      (r) => r.company_cik === company.cik,
    );
    const companyTxns = (txns ?? []).filter(
      (t) => t.company_cik === company.cik,
    );

    const insidersWithTxns = companyRelations.map((rel) => {
      const insiderTxns = companyTxns
        .filter((t) => t.insider_cik === rel.insider_cik)
        .map((t) => ({
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
    };
  });

  // Sort companies by latest transaction date
  result.sort((a, b) => {
    const aDate = a.latestTransactionDate ?? "";
    const bDate = b.latestTransactionDate ?? "";
    return bDate.localeCompare(aDate);
  });

  return NextResponse.json({ count: result.length, companies: result });
}
