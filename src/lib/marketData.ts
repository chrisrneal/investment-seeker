// Market data helpers — lightweight wrappers around Yahoo Finance APIs.
// Results are cached in memory with a 24-hour TTL.

export type ShortInterest = {
  shortPercentOfFloat: number | null;
  shortRatio: number | null;
  fetchedAt: string;
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Module-level cache. Persists across requests in a long-lived Node.js process.
const shortInterestCache = new Map<string, { data: ShortInterest; ts: number }>();

/**
 * Fetch short interest data for a ticker from Yahoo Finance quoteSummary.
 *
 * Extracts:
 *  - shortPercentOfFloat  (e.g. 0.043 = 4.3 % of float is short)
 *  - shortRatio           (days to cover)
 *
 * Returns null on network error or if Yahoo Finance has no data for the ticker.
 * Results are cached in-process for 24 hours.
 */
export async function fetchShortInterest(
  ticker: string
): Promise<ShortInterest | null> {
  const key = ticker.toUpperCase();

  const hit = shortInterestCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;

  try {
    const url =
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/` +
      `${encodeURIComponent(key)}?modules=defaultKeyStatistics`;

    const res = await fetch(url, {
      headers: { "User-Agent": "InvestmentSeeker/1.0" },
      // Don't let Yahoo Finance latency block the whole page for long.
      signal: AbortSignal.timeout(6_000),
    });

    if (!res.ok) return null;

    const json = await res.json();
    const ks = json?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
    if (!ks) return null;

    const data: ShortInterest = {
      shortPercentOfFloat: ks.shortPercentOfFloat?.raw ?? null,
      shortRatio: ks.shortRatio?.raw ?? null,
      fetchedAt: new Date().toISOString(),
    };

    shortInterestCache.set(key, { data, ts: Date.now() });
    return data;
  } catch {
    // Network error, timeout, or bad JSON — non-fatal.
    return null;
  }
}
