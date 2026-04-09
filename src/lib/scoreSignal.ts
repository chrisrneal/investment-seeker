import type {
  FundamentalsSnapshot,
  ParsedForm4Transaction,
  ScoredSignal,
  ShortInterest,
  SignalBreakdown,
} from "./types";
import { getSupabaseClient } from "./supabase";
import { fetchShortInterest } from "./marketData";

// ── Weight constants (sum to 100) ──────────────────────────────────

const W_CLUSTER = 25;
const W_ROLE = 20;
const W_PURCHASE_TYPE = 25;
const W_HOLDINGS = 15;
const W_PRICE_DIP = 15;

// ── Helpers ────────────────────────────────────────────────────────

const SENIOR_TITLES = /\b(ceo|cfo|coo|cto|president|chief)\b/i;

function daysBetween(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return Infinity;
  return Math.abs(da - db) / 86_400_000;
}

// ── 52-week price data (Yahoo Finance v8 chart) ────────────────────

type PriceContext = {
  currentPrice: number;
  fiftyTwoWeekLow: number;
  fiftyTwoWeekHigh: number;
};

async function fetchPriceContext(
  ticker: string
): Promise<PriceContext | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?range=1y&interval=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "InvestmentSeeker/1.0" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const closes: number[] =
      data.chart.result[0].indicators?.quote?.[0]?.close?.filter(
        (v: unknown) => typeof v === "number"
      ) ?? [];
    if (closes.length === 0) return null;
    const currentPrice = meta.regularMarketPrice ?? closes[closes.length - 1];
    const fiftyTwoWeekLow = Math.min(...closes);
    const fiftyTwoWeekHigh = Math.max(...closes);
    return { currentPrice, fiftyTwoWeekLow, fiftyTwoWeekHigh };
  } catch {
    return null;
  }
}

// ── Fundamentals (Yahoo Finance quoteSummary) ──────────────────────

const FUNDAMENTALS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function fetchFundamentals(
  ticker: string
): Promise<FundamentalsSnapshot | null> {
  // 1. Check Supabase cache first.
  try {
    const db = getSupabaseClient();
    const { data: cached } = await db
      .from("fundamentals_cache")
      .select("data, fetched_at")
      .eq("ticker", ticker.toUpperCase())
      .single();

    if (cached) {
      const age = Date.now() - new Date(cached.fetched_at as string).getTime();
      if (age < FUNDAMENTALS_TTL_MS) {
        return cached.data as FundamentalsSnapshot;
      }
    }
  } catch {
    // Supabase unavailable — fall through to live fetch.
  }

  // 2. Fetch from Yahoo Finance quoteSummary.
  let snapshot: FundamentalsSnapshot | null = null;
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      ticker
    )}?modules=financialData,defaultKeyStatistics`;
    const res = await fetch(url, {
      headers: { "User-Agent": "InvestmentSeeker/1.0" },
    });
    if (res.ok) {
      const json = await res.json();
      const result = json?.quoteSummary?.result?.[0];
      const fd = result?.financialData;
      const ks = result?.defaultKeyStatistics;
      if (fd || ks) {
        snapshot = {
          trailingPE: ks?.trailingPE?.raw ?? null,
          revenueGrowth: fd?.revenueGrowth?.raw ?? null,
          grossMargins: fd?.grossMargins?.raw ?? null,
          totalCash: fd?.totalCash?.raw ?? null,
          debtToEquity: fd?.debtToEquity?.raw ?? null,
          fetchedAt: new Date().toISOString(),
        };
      }
    }
  } catch {
    return null;
  }

  // 3. Persist to Supabase cache.
  if (snapshot) {
    try {
      const db = getSupabaseClient();
      await db.from("fundamentals_cache").upsert(
        { ticker: ticker.toUpperCase(), data: snapshot, fetched_at: snapshot.fetchedAt },
        { onConflict: "ticker" }
      );
    } catch {
      // Cache write failure is non-fatal.
    }
  }

  return snapshot;
}

// ── Scoring functions (each returns 0-1) ───────────────────────────

/** Multiple insiders buying within 30 days = high signal. */
function scoreClusterBuying(txns: ParsedForm4Transaction[]): number {
  const buys = txns.filter((t) => t.transactionType === "buy");
  if (buys.length === 0) return 0;

  const uniqueBuyers = new Set(buys.map((t) => t.officerName));
  if (uniqueBuyers.size <= 1) return 0.2;

  // Check if multiple buys fall within a 30-day window.
  const dates = buys.map((t) => t.transactionDate).sort();
  const windowHit = dates.some((d, i) =>
    dates.slice(i + 1).some((d2) => daysBetween(d, d2) <= 30)
  );

  if (!windowHit) return 0.3;
  // Scale by number of unique insiders.
  return Math.min(1, 0.4 + uniqueBuyers.size * 0.2);
}

/** CEO/CFO purchases weighted higher than board members. */
function scoreInsiderRole(txns: ParsedForm4Transaction[]): number {
  const buys = txns.filter((t) => t.transactionType === "buy");
  if (buys.length === 0) return 0;

  const hasSenior = buys.some((t) => SENIOR_TITLES.test(t.officerTitle));
  const hasDirector = buys.some((t) =>
    /\bdirector\b/i.test(t.officerTitle)
  );

  if (hasSenior) return 1;
  if (hasDirector) return 0.5;
  return 0.25;
}

/** Open market purchases >> option exercises. */
function scorePurchaseType(txns: ParsedForm4Transaction[]): number {
  const openMarket = txns.filter((t) => t.transactionCode === "P");
  const exercises = txns.filter((t) => t.transactionType === "exercise");
  const total = openMarket.length + exercises.length;
  if (total === 0) return 0;

  const omRatio = openMarket.length / total;
  // Pure open-market buying = 1.0, pure exercises = 0.15
  return 0.15 + omRatio * 0.85;
}

/** Buying >10% of existing holdings = strong conviction. */
function scoreRelativeHoldings(txns: ParsedForm4Transaction[]): number {
  const buys = txns.filter((t) => t.transactionType === "buy");
  if (buys.length === 0) return 0;

  const maxRatio = Math.max(
    ...buys.map((t) => {
      const prior = t.sharesOwnedAfter - t.sharesTraded;
      if (prior <= 0) return 1; // Bought from zero — max conviction signal.
      return t.sharesTraded / prior;
    })
  );

  if (maxRatio >= 0.25) return 1;
  if (maxRatio >= 0.1) return 0.7;
  if (maxRatio >= 0.05) return 0.4;
  return 0.15;
}

/** Price near 52-week low = buying the dip. */
function scorePriceDip(price: PriceContext | null): number {
  if (!price) return 0.5; // Neutral when data unavailable.
  const range = price.fiftyTwoWeekHigh - price.fiftyTwoWeekLow;
  if (range <= 0) return 0.5;
  // 0 = at 52wk high, 1 = at 52wk low.
  const position =
    1 - (price.currentPrice - price.fiftyTwoWeekLow) / range;
  return Math.max(0, Math.min(1, position));
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Score a set of parsed Form 4 transactions for a single ticker.
 */
export async function scoreSignal(
  ticker: string,
  transactions: ParsedForm4Transaction[]
): Promise<ScoredSignal> {
  const [priceCtx, fundamentals, shortInterest] = await Promise.all([
    fetchPriceContext(ticker),
    fetchFundamentals(ticker),
    fetchShortInterest(ticker),
  ]);

  const cluster = scoreClusterBuying(transactions);
  const role = scoreInsiderRole(transactions);
  const purchaseType = scorePurchaseType(transactions);
  const holdings = scoreRelativeHoldings(transactions);
  const priceDip = scorePriceDip(priceCtx);

  // Bonus +10 when short float >20% AND insider buying present — high short
  // interest amplifies the significance of insiders going long against the crowd.
  const hasBuys = transactions.some((t) => t.transactionType === "buy");
  const shortInterestBonus =
    hasBuys &&
    shortInterest?.shortPercentOfFloat != null &&
    shortInterest.shortPercentOfFloat > 0.20
      ? 10
      : 0;

  const breakdown: SignalBreakdown = {
    clusterBuyingScore: Math.round(cluster * W_CLUSTER),
    insiderRoleScore: Math.round(role * W_ROLE),
    purchaseTypeScore: Math.round(purchaseType * W_PURCHASE_TYPE),
    relativeHoldingsScore: Math.round(holdings * W_HOLDINGS),
    priceDipScore: Math.round(priceDip * W_PRICE_DIP),
    shortInterestBonus,
  };

  const score = Math.min(
    100,
    breakdown.clusterBuyingScore +
      breakdown.insiderRoleScore +
      breakdown.purchaseTypeScore +
      breakdown.relativeHoldingsScore +
      breakdown.priceDipScore +
      breakdown.shortInterestBonus
  );

  const rationale = buildRationale(
    score,
    transactions,
    priceCtx,
    shortInterest,
    cluster,
    role,
    purchaseType,
    holdings,
    priceDip
  );

  return {
    score,
    rationale,
    breakdown,
    ticker,
    transactionCount: transactions.length,
    fundamentals,
    shortInterest,
  };
}

// ── Rationale builder ──────────────────────────────────────────────

function buildRationale(
  score: number,
  txns: ParsedForm4Transaction[],
  priceCtx: PriceContext | null,
  shortInterest: ShortInterest | null,
  cluster: number,
  role: number,
  purchaseType: number,
  holdings: number,
  priceDip: number
): string {
  const parts: string[] = [];

  const buys = txns.filter((t) => t.transactionType === "buy");
  const uniqueBuyers = new Set(buys.map((t) => t.officerName));
  const totalValue = buys.reduce((s, t) => s + t.totalValue, 0);

  if (buys.length === 0) {
    parts.push("No open-market purchases detected — limited buy signal.");
  } else {
    parts.push(
      `${uniqueBuyers.size} insider(s) bought shares worth ~$${Math.round(totalValue).toLocaleString()}.`
    );
  }

  if (cluster >= 0.7) parts.push("Cluster buying detected (strong signal).");
  if (role >= 0.8)
    parts.push("Senior executive (CEO/CFO-level) participated.");
  if (purchaseType >= 0.8)
    parts.push("Predominantly open-market purchases (not option exercises).");
  if (holdings >= 0.7) parts.push("Significant relative to existing holdings.");

  if (priceCtx) {
    if (priceDip >= 0.7) parts.push("Price near 52-week low — buying the dip.");
    else if (priceDip <= 0.3) parts.push("Price near 52-week high — buying into strength.");
  }

  if (
    shortInterest?.shortPercentOfFloat != null &&
    shortInterest.shortPercentOfFloat > 0.20 &&
    buys.length > 0
  ) {
    parts.push(
      `High short interest (${(shortInterest.shortPercentOfFloat * 100).toFixed(1)}% of float) — insider buying into elevated short pressure (+10 ICS bonus).`
    );
  }

  const label =
    score >= 75
      ? "Strong opportunity signal"
      : score >= 50
        ? "Moderate opportunity signal"
        : score >= 25
          ? "Weak signal"
          : "Minimal signal";

  return `${label} (${score}/100). ${parts.join(" ")}`;
}
