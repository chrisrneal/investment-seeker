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

// ── Annual filings (10-Q / 10-K) ─────────────────────────────────────────────

export type AnnualFilingResult = {
  ticker: string;
  formType: string;
  filingDate: string;
  /** ISO date string parsed from the EDGAR filing index; empty if unavailable. */
  periodOfReport: string;
  primaryDocUrl: string | null;
  /** Up to 3,000 characters of plain text from the MD&A section. */
  mdaExcerpt: string;
};

function stripAnnualHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegexChars(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the URL of the primary document (10-Q or 10-K, not an amendment) from
 * the EDGAR filing index HTML. Falls back to the first .htm link if needed.
 */
function findAnnualPrimaryDocUrl(
  indexHtml: string,
  formType: string,
  baseUrl: string
): string | null {
  const typeRe = new RegExp(`>\\s*${escapeRegexChars(formType)}\\s*<`, "i");
  const amendRe = new RegExp(`>\\s*${escapeRegexChars(formType)}/A\\s*<`, "i");

  for (const rowMatch of indexHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1];
    if (typeRe.test(row) && !amendRe.test(row)) {
      const m = row.match(/href="([^"]+\.htm[l]?)"/i);
      if (m) {
        return m[1].startsWith("http") ? m[1] : new URL(m[1], baseUrl).toString();
      }
    }
  }
  // Fallback: first .htm link in the index
  const m = indexHtml.match(/href="([^"]+\.htm[l]?)"/i);
  return m ? (m[1].startsWith("http") ? m[1] : new URL(m[1], baseUrl).toString()) : null;
}

/**
 * Extract the "Period of Report" value from an EDGAR filing index page.
 * The index contains a row like: <td>Period of Report:</td><td>2024-03-31</td>
 */
function parsePeriodOfReport(indexHtml: string): string {
  const m = indexHtml.match(/period\s+of\s+report[^<]*<\/td>\s*<td[^>]*>([^<]+)/i);
  return m ? m[1].trim() : "";
}

const MDA_MAX_LENGTH = 3000;

/**
 * Locate the MD&A section in plain text and return up to 3,000 characters.
 *
 * Strategy:
 *  1. Find "Item 2" followed by "Management" or "Discussion" (works for 10-Q
 *     and 10-K alike — 10-Q Item 2 IS the MD&A section).
 *  2. For 10-K, fall back to "Item 7" if Item 2 isn't found.
 *  3. Last resort: return the first 3,000 characters of the document.
 */
function extractMdaExcerpt(plainText: string, formType: string): string {
  const item2Start = plainText.search(
    /\bitem\s+2\b[^a-z0-9]*(?:management|discussion)/i
  );
  if (item2Start !== -1) {
    const after = plainText.slice(item2Start);
    const endIdx = after.search(/\bitem\s+3\b/i);
    return (endIdx !== -1 ? after.slice(0, endIdx) : after)
      .trim()
      .slice(0, MDA_MAX_LENGTH);
  }

  if (formType === "10-K") {
    const item7Start = plainText.search(
      /\bitem\s+7\b[^a-z0-9]*(?:management|discussion)/i
    );
    if (item7Start !== -1) {
      const after = plainText.slice(item7Start);
      const endIdx = after.search(/\bitem\s+(?:7a|8)\b/i);
      return (endIdx !== -1 ? after.slice(0, endIdx) : after)
        .trim()
        .slice(0, MDA_MAX_LENGTH);
    }
  }

  return plainText.slice(0, MDA_MAX_LENGTH);
}

/**
 * Fetch the primary document of a single 10-Q or 10-K filing result,
 * parse the MD&A section, and return a structured `AnnualFilingResult`.
 *
 * All network failures are non-fatal — partial results are returned.
 */
export async function fetchAnnualFilingDoc(
  filing: FilingResult,
  ticker: string
): Promise<AnnualFilingResult> {
  const base: AnnualFilingResult = {
    ticker: ticker.toUpperCase(),
    formType: filing.filingType,
    filingDate: filing.filingDate,
    periodOfReport: "",
    primaryDocUrl: null,
    mdaExcerpt: "",
  };

  let indexHtml: string;
  try {
    const res = await secFetch(filing.link);
    if (!res.ok) return base;
    indexHtml = await res.text();
  } catch {
    return base;
  }

  const primaryDocUrl = findAnnualPrimaryDocUrl(indexHtml, filing.filingType, filing.link);
  const periodOfReport = parsePeriodOfReport(indexHtml);

  if (!primaryDocUrl) return { ...base, periodOfReport };

  try {
    const docRes = await secFetch(primaryDocUrl);
    if (!docRes.ok) return { ...base, primaryDocUrl, periodOfReport };
    const plainText = stripAnnualHtml(await docRes.text());
    const mdaExcerpt = extractMdaExcerpt(plainText, filing.filingType);
    return { ...base, primaryDocUrl, periodOfReport, mdaExcerpt };
  } catch {
    return { ...base, primaryDocUrl, periodOfReport };
  }
}

/**
 * Fetch the last 4 quarterly (10-Q) and 2 annual (10-K) filings for `ticker`,
 * extract the MD&A section from each primary document, and return the results.
 */
export async function fetchAnnualFilings(ticker: string): Promise<AnnualFilingResult[]> {
  const [qRes, kRes] = await Promise.all([
    searchFilings({ formType: "10-Q", ticker, pageSize: 4 })
      .then((r) => r.results)
      .catch(() => [] as FilingResult[]),
    searchFilings({ formType: "10-K", ticker, pageSize: 2 })
      .then((r) => r.results)
      .catch(() => [] as FilingResult[]),
  ]);

  const results: AnnualFilingResult[] = [];
  for (const filing of [...qRes, ...kRes]) {
    results.push(await fetchAnnualFilingDoc(filing, ticker));
  }
  return results;
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
