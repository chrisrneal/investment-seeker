// SEC EDGAR client with a token-bucket rate limiter.
//
// SEC fair access policy: max 10 requests/second, and a descriptive
// User-Agent including a contact email is required.
// https://www.sec.gov/os/accessing-edgar-data

const MAX_RPS = 10;
const REFILL_INTERVAL_MS = 1000 / MAX_RPS; // 100ms between tokens

type Bucket = {
  tokens: number;
  lastRefill: number;
};

// Module-level state. In serverless this is per-instance, which is fine:
// each instance self-limits to <= 10 rps. For higher scale use a shared store.
const bucket: Bucket = {
  tokens: MAX_RPS,
  lastRefill: Date.now(),
};

function refill() {
  const now = Date.now();
  const elapsed = now - bucket.lastRefill;
  if (elapsed <= 0) return;
  const add = Math.floor(elapsed / REFILL_INTERVAL_MS);
  if (add > 0) {
    bucket.tokens = Math.min(MAX_RPS, bucket.tokens + add);
    bucket.lastRefill += add * REFILL_INTERVAL_MS;
  }
}

async function take(): Promise<void> {
  // Wait until a token is available, then consume it.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    refill();
    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      return;
    }
    const waitMs = REFILL_INTERVAL_MS - (Date.now() - bucket.lastRefill);
    await new Promise((r) => setTimeout(r, Math.max(1, waitMs)));
  }
}

function userAgent(): string {
  const email = process.env.SEC_USER_AGENT_EMAIL || "your-email@example.com";
  return `Investment Seeker (${email})`;
}

export async function secFetch(url: string): Promise<Response> {
  await take();
  return fetch(url, {
    headers: {
      "User-Agent": userAgent(),
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      Host: new URL(url).host,
    },
    // EDGAR data changes often; don't cache aggressively.
    cache: "no-store",
  });
}

// ---------- EDGAR full-text search ----------

export type FilingResult = {
  filerName: string;
  ticker: string | null;
  filingDate: string;
  filingType: string;
  link: string;
  accessionNo: string;
  cik: string | null;
};

type EdgarHit = {
  _id: string;
  _source: {
    display_names?: string[];
    form?: string;
    file_date?: string;
    ciks?: string[];
    tickers?: string[] | string;
    adsh?: string;
  };
};

type EdgarResponse = {
  hits?: {
    total?: { value: number };
    hits?: EdgarHit[];
  };
};

// Extract ticker from EDGAR display_names like "APPLE INC  (AAPL) (CIK 0000320193)"
function parseTickerFromDisplayName(name: string | undefined): string | null {
  if (!name) return null;
  const m = name.match(/\(([A-Z.\-]{1,10})\)\s*\(CIK/);
  return m ? m[1] : null;
}

function parseCikFromDisplayName(name: string | undefined): string | null {
  if (!name) return null;
  const m = name.match(/CIK\s+(\d{1,10})/);
  return m ? m[1] : null;
}

// Build a link to the filing index on EDGAR given accession number and CIK.
function buildFilingLink(accessionNo: string, cik: string | null): string {
  // accessionNo is returned like "0000320193-24-000123" from _id or adsh.
  if (!cik) {
    return `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(
      accessionNo
    )}`;
  }
  const cikNoPad = String(parseInt(cik, 10));
  const accNoDash = accessionNo.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${accNoDash}/${accessionNo}-index.htm`;
}

export type SearchFilingsParams = {
  formType: string; // "4" | "8-K" | "13F" | "13F-HR" | ...
  ticker?: string;
  /** Date range filter (YYYY-MM-DD). Both inclusive. */
  startDate?: string;
  endDate?: string;
  /** Max results per page (EDGAR max is 100). */
  pageSize?: number;
  /** Pagination offset (0-based). */
  from?: number;
};

export type SearchFilingsResult = {
  results: FilingResult[];
  total: number; // total matching results reported by EDGAR
};

export async function searchFilings(
  params: SearchFilingsParams
): Promise<SearchFilingsResult> {
  const { formType, ticker, startDate, endDate, pageSize = 100, from = 0 } = params;

  const url = new URL("https://efts.sec.gov/LATEST/search-index");
  // q is required by EDGAR; use ticker if present, else empty string.
  url.searchParams.set("q", ticker ? `"${ticker}"` : "");
  url.searchParams.set("forms", formType);
  url.searchParams.set("from", String(from));
  url.searchParams.set("size", String(Math.min(pageSize, 100)));

  if (startDate && endDate) {
    url.searchParams.set("dateRange", "custom");
    url.searchParams.set("startdt", startDate);
    url.searchParams.set("enddt", endDate);
  }

  const res = await secFetch(url.toString());
  if (!res.ok) {
    throw new Error(`EDGAR search failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as EdgarResponse;

  const total = data.hits?.total?.value ?? 0;
  const hits = data.hits?.hits ?? [];

  const results: FilingResult[] = hits.map((h) => {
    const src = h._source;
    const displayName = src.display_names?.[0];
    const filerName = displayName?.replace(/\s*\(CIK.*$/, "").trim() ?? "";
    const cik = src.ciks?.[0] ?? parseCikFromDisplayName(displayName);
    const tkr =
      (Array.isArray(src.tickers) ? src.tickers[0] : src.tickers) ||
      parseTickerFromDisplayName(displayName);

    // _id is typically "<accession>:<primaryDoc>" — take the accession part.
    const accessionNo = (src.adsh || h._id.split(":")[0] || "").trim();

    return {
      filerName,
      ticker: tkr ?? null,
      filingDate: src.file_date ?? "",
      filingType: src.form ?? formType,
      link: buildFilingLink(accessionNo, cik),
      accessionNo,
      cik,
    };
  });

  return { results, total };
}

/**
 * Paginate through all EDGAR search results for a form type within a date range.
 * - Caps at `maxResults` to stay within SEC fair-access bounds.
 * - Each page is 100 results (EDGAR max per request).
 * - EDGAR caps `from` at 10,000 — we respect that hard limit.
 */
export async function searchAllFilings(
  params: Omit<SearchFilingsParams, "from" | "pageSize"> & { maxResults?: number }
): Promise<FilingResult[]> {
  const PAGE_SIZE = 100;
  const EDGAR_MAX_FROM = 10_000; // Elasticsearch default max window
  const maxResults = Math.min(params.maxResults ?? 2000, EDGAR_MAX_FROM);

  const allResults: FilingResult[] = [];
  let from = 0;

  while (from < maxResults) {
    const { results, total } = await searchFilings({
      ...params,
      pageSize: PAGE_SIZE,
      from,
    });

    allResults.push(...results);
    from += PAGE_SIZE;

    // Stop if we've fetched everything or hit our cap
    if (results.length < PAGE_SIZE || from >= total || allResults.length >= maxResults) {
      break;
    }
  }

  return allResults.slice(0, maxResults);
}
