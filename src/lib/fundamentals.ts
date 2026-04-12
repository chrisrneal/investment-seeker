// Extended Yahoo Finance fundamentals fetcher.
// Caches results in the existing `fundamentals_cache` Supabase table (JSONB data column).
// Use this module when you need fields beyond what scoreSignal.ts's internal
// fetchFundamentals() provides (forwardPE, operatingMargins, totalDebt, etc.).

import { getSupabaseClient } from "./supabase";
import type { FundamentalsSnapshot } from "./types";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function fetchFundamentals(
  ticker: string
): Promise<FundamentalsSnapshot> {
  const key = ticker.toUpperCase();

  // 1. Check Supabase cache.
  try {
    const db = getSupabaseClient();
    const { data: cached } = await db
      .from("fundamentals_cache")
      .select("data, fetched_at")
      .eq("ticker", key)
      .single();

    if (cached) {
      const age = Date.now() - new Date(cached.fetched_at as string).getTime();
      if (age < TTL_MS) {
        return cached.data as FundamentalsSnapshot;
      }
    }
  } catch {
    // Cache unavailable — fall through.
  }

  // 2. Fetch from Yahoo Finance quoteSummary.
  const snapshot = await fetchFromYahoo(key);

  // 3. Persist to cache (best-effort).
  if (snapshot) {
    try {
      const db = getSupabaseClient();
      await db.from("fundamentals_cache").upsert(
        { ticker: key, data: snapshot, fetched_at: snapshot.fetchedAt },
        { onConflict: "ticker" }
      );
    } catch {
      // Non-fatal.
    }
  }

  return snapshot ?? emptySnapshot(key);
}

function emptySnapshot(ticker: string): FundamentalsSnapshot {
  return {
    ticker,
    trailingPE: null,
    forwardPE: null,
    revenueGrowth: null,
    grossMargins: null,
    operatingMargins: null,
    totalCash: null,
    totalDebt: null,
    debtToEquity: null,
    returnOnEquity: null,
    shortPercentOfFloat: null,
    shortRatio: null,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchFromYahoo(
  ticker: string
): Promise<FundamentalsSnapshot | null> {
  try {
    const url =
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/` +
      `${encodeURIComponent(ticker)}?modules=financialData,defaultKeyStatistics`;

    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!res.ok) return null;

    const json = await res.json();
    const result = json?.quoteSummary?.result?.[0];
    const fd = result?.financialData;
    const ks = result?.defaultKeyStatistics;

    if (!fd && !ks) return null;

    const safe = (obj: unknown, key: string): number | null => {
      try {
        const val = (obj as Record<string, { raw?: number }>)?.[key]?.raw;
        return typeof val === "number" ? val : null;
      } catch {
        return null;
      }
    };

    return {
      ticker,
      trailingPE: safe(ks, "trailingPE"),
      forwardPE: safe(ks, "forwardPE"),
      revenueGrowth: safe(fd, "revenueGrowth"),
      grossMargins: safe(fd, "grossMargins"),
      operatingMargins: safe(fd, "operatingMargins"),
      totalCash: safe(fd, "totalCash"),
      totalDebt: safe(fd, "totalDebt"),
      debtToEquity: safe(fd, "debtToEquity"),
      returnOnEquity: safe(fd, "returnOnEquity"),
      shortPercentOfFloat: safe(ks, "shortPercentOfFloat"),
      shortRatio: safe(ks, "shortRatio"),
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
