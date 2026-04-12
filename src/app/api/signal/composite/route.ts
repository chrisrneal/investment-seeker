import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { getAuthUser, unauthorizedResponse } from "@/lib/auth";
import { computeCompositeScore } from "@/lib/compositeScore";
import type { ApiError, CompositeScore, ParsedForm4Transaction } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_HOURS = 6;

function errorJson(error: string, detail: string | undefined, status: number) {
  return NextResponse.json({ error, detail } satisfies ApiError, { status });
}

/**
 * GET /api/signal/composite?ticker=TICKER
 *
 * Returns a CompositeScore combining ICS, fundamentals, valuation, and catalyst.
 * Results are cached in composite_score_cache for 6 hours.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return unauthorizedResponse();

  const ticker = new URL(req.url).searchParams.get("ticker")?.trim().toUpperCase();
  if (!ticker) {
    return errorJson("Missing required query param 'ticker'", undefined, 400);
  }

  const supabase = getSupabaseClient();
  const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 3600_000).toISOString();

  // ── Cache check ──────────────────────────────────────────────────
  type CacheRow = {
    total: number; breakdown: unknown; fundamentals: unknown;
    insider_signal: unknown; rationale: string; computed_at: string;
  };
  const { data: cached } = await supabase
    .from("composite_score_cache")
    .select("total, breakdown, fundamentals, insider_signal, rationale, computed_at")
    .eq("ticker", ticker)
    .gte("computed_at", cutoff)
    .maybeSingle() as { data: CacheRow | null; error: unknown };

  if (cached) {
    const result: CompositeScore & { cached: boolean } = {
      ticker,
      total: cached.total,
      breakdown: cached.breakdown as CompositeScore["breakdown"],
      fundamentals: cached.fundamentals as CompositeScore["fundamentals"],
      insiderSignal: cached.insider_signal as CompositeScore["insiderSignal"],
      rationale: cached.rationale,
      computedAt: cached.computed_at,
      cached: true,
    };
    return NextResponse.json(result);
  }

  // ── Fetch transactions (buys, last 90 days) ───────────────────────
  const cutoff90d = new Date(Date.now() - 90 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  type CompanyRow = { cik: string };
  const { data: companies } = await supabase
    .from("companies")
    .select("cik")
    .ilike("ticker", ticker)
    .limit(1) as { data: CompanyRow[] | null; error: unknown };

  const cik = companies?.[0]?.cik ?? null;

  let transactions: ParsedForm4Transaction[] = [];
  if (cik) {
    type TxnRow = {
      insider_cik: string; transaction_type: string; transaction_code: string | null;
      shares: number; price_per_share: number; total_value: number;
      shares_owned_after: number; transaction_date: string; is_direct_ownership: boolean;
    };
    type InsiderRow = { cik: string; name: string };
    type RelRow = { insider_cik: string; title: string | null };

    const [txnRes, insRes, relRes] = await Promise.all([
      supabase
        .from("transactions")
        .select("insider_cik, transaction_type, transaction_code, shares, price_per_share, total_value, shares_owned_after, transaction_date, is_direct_ownership")
        .eq("company_cik", cik)
        .eq("transaction_type", "buy")
        .gte("transaction_date", cutoff90d)
        .order("transaction_date", { ascending: false })
        .limit(50) as unknown as Promise<{ data: TxnRow[] | null; error: unknown }>,
      supabase
        .from("insiders")
        .select("cik, name") as unknown as Promise<{ data: InsiderRow[] | null; error: unknown }>,
      supabase
        .from("company_insiders")
        .select("insider_cik, title")
        .eq("company_cik", cik) as unknown as Promise<{ data: RelRow[] | null; error: unknown }>,
    ]);

    const insiderMap = new Map((insRes.data ?? []).map((i) => [i.cik, i.name]));
    const titleMap = new Map((relRes.data ?? []).map((r) => [r.insider_cik, r.title ?? ""]));

    transactions = (txnRes.data ?? []).map((t) => ({
      officerName: insiderMap.get(t.insider_cik) ?? "Unknown",
      officerTitle: titleMap.get(t.insider_cik) ?? "",
      transactionType: t.transaction_type as ParsedForm4Transaction["transactionType"],
      transactionCode: t.transaction_code ?? "",
      sharesTraded: t.shares,
      pricePerShare: t.price_per_share,
      totalValue: t.total_value,
      sharesOwnedAfter: t.shares_owned_after,
      transactionDate: t.transaction_date,
      isDirectOwnership: t.is_direct_ownership,
    }));
  }

  // ── 13D/G count ───────────────────────────────────────────────────
  let thirteenDGCount = 0;
  try {
    const { count } = await supabase
      .from("thirteen_dg_filings")
      .select("id", { count: "exact", head: true })
      .ilike("subject_company_ticker", ticker);
    thirteenDGCount = count ?? 0;
  } catch {
    // Table may not exist — non-fatal.
  }

  // ── Compute ───────────────────────────────────────────────────────
  let score: CompositeScore;
  try {
    score = await computeCompositeScore(ticker, transactions, thirteenDGCount);
  } catch (err) {
    return errorJson(
      "Composite score computation failed",
      err instanceof Error ? err.message : "Unknown error",
      502
    );
  }

  // ── Cache result ──────────────────────────────────────────────────
  try {
    await supabase.from("composite_score_cache").upsert(
      {
        ticker,
        total: score.total,
        breakdown: score.breakdown,
        fundamentals: score.fundamentals,
        insider_signal: score.insiderSignal,
        rationale: score.rationale,
        computed_at: score.computedAt,
      },
      { onConflict: "ticker" }
    );
  } catch {
    // Non-fatal.
  }

  return NextResponse.json({ ...score, cached: false });
}
