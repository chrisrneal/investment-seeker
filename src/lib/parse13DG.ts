import { secFetch } from "./sec";
import type { Parsed13DG } from "./types";

// ── Helpers ──────────────────────────────────────────────────────

function stripHtml(html: string): string {
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

/**
 * Find the primary document URL in the EDGAR filing index HTML.
 * Looks for a .htm or .txt file that is not the index itself and not an XML file.
 */
function findPrimaryDocUrl(indexHtml: string, baseUrl: string): string | null {
  // Try rows that match SC 13 or primary document marker
  for (const rowMatch of indexHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1];
    if (/(SC\s*13[DG]|primary\s+doc)/i.test(row) || /type.*text\/html/i.test(row)) {
      const m = row.match(/href="([^"]+\.(?:htm[l]?|txt))"/i);
      if (m && !/\/xsl/i.test(m[1]) && !/index/i.test(m[1])) {
        return m[1].startsWith("http") ? m[1] : new URL(m[1], baseUrl).toString();
      }
    }
  }
  // Fallback: first non-index, non-XSL .htm or .txt link
  for (const m of indexHtml.matchAll(/href="([^"]+\.(?:htm[l]?|txt))"/gi)) {
    if (!/\/xsl/i.test(m[1]) && !/index/i.test(m[1])) {
      return m[1].startsWith("http") ? m[1] : new URL(m[1], baseUrl).toString();
    }
  }
  return null;
}

/** Extract subject company name from the cover page. */
function extractSubjectCompanyName(text: string): string {
  const patterns = [
    /name\s+of\s+issuer[:\s]+([^\n.]{2,80})/i,
    /issuer[:\s]+([A-Z][^\n.]{2,60}(?:inc|corp|llc|ltd|plc|co\.?)?[^\n.]{0,20})/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const name = m[1].replace(/\s+/g, " ").trim();
      if (name.length > 2 && name.length < 80) return name;
    }
  }
  return "";
}

/** Extract subject company ticker symbol from the cover page. */
function extractSubjectCompanyTicker(text: string, hintTicker: string | null): string | null {
  const tickerPatterns = [
    /ticker\s*(?:symbol)?[:\s]+\(?([A-Z]{1,5})\)?/i,
    /common\s+stock[^)]{0,60}\(([A-Z]{1,5})\)/i,
    /class\s+[a-z]\s+common[^)]{0,60}\(([A-Z]{1,5})\)/i,
    /\bsymbol[:\s]+([A-Z]{1,5})\b/i,
    /\b(NASDAQ|NYSE|AMEX)[:\s\/]+([A-Z]{1,5})\b/i,
    /name\s+of\s+issuer[^(]{5,80}\(([A-Z]{1,5})\)/i,
  ];
  for (const pat of tickerPatterns) {
    const m = text.match(pat);
    if (m) {
      const tkr = (m[2] || m[1]).trim().toUpperCase();
      if (tkr.length >= 1 && tkr.length <= 5 && /^[A-Z]+$/.test(tkr)) return tkr;
    }
  }
  return hintTicker;
}

/** Extract subject company CIK from the cover page or EDGAR headers. */
function extractSubjectCompanyCik(text: string): string | null {
  const patterns = [
    /(?:subject\s+company|issuer)\s+cik[:\s]+(\d{6,10})/i,
    /cik[:\s]+(\d{6,10})[^\n]{0,40}(?:subject|issuer)/i,
    /0{0,4}(\d{6,10})\s*\(CIK\)/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[1];
  }
  return null;
}

/** Extract the percent of class represented by the amount. */
function extractPercentOfClass(text: string): number | null {
  const patterns = [
    /percent\s+of\s+class\s+represented\s+by\s+amount[:\s]+(\d{1,3}(?:\.\d{1,4})?)\s*%/i,
    /percent\s+of\s+class[:\s]+(\d{1,3}(?:\.\d{1,4})?)\s*%/i,
    /(\d{1,3}(?:\.\d{1,4})?)\s*%\s+of\s+(?:the\s+)?(?:outstanding|class|total)/i,
    /aggregate\s+(?:beneficial\s+)?ownership[^%]{0,60}(\d{1,3}(?:\.\d{1,4})?)\s*%/i,
    /row\s+11[^%\n]{0,80}(\d{1,3}(?:\.\d{1,4})?)\s*%/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const pct = parseFloat(m[1]);
      if (!isNaN(pct) && pct > 0 && pct <= 100) return pct;
    }
  }
  return null;
}

/** Extract the aggregate amount beneficially owned (number of shares). */
function extractAggregateAmount(text: string): number | null {
  const patterns = [
    /aggregate\s+amount\s+beneficially\s+owned[:\s]+([\d,]+)/i,
    /row\s+9[^:\n]{0,40}[:\s]([\d,]+)/i,
    /amount\s+beneficially\s+owned[:\s]+([\d,]+)/i,
    /number\s+of\s+shares[^:\n]{0,60}[:\s]([\d,]+)/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (!isNaN(val) && val > 0) return val;
    }
  }
  return null;
}

/** Extract Item 4 "Purpose of Transaction" text (up to 1,500 chars). */
function extractItem4Excerpt(text: string): string | null {
  const item4Match = text.match(
    /item\s+4[.\s]*(?:purpose\s+of\s+(?:the\s+)?transaction[^\n]*)?\n([\s\S]{10,})/i
  );
  if (!item4Match) return null;

  const after = item4Match[1];
  const item5Idx = after.search(/\bitem\s+5\b/i);
  const raw = item5Idx !== -1 ? after.slice(0, item5Idx) : after;
  const excerpt = raw.replace(/\s+/g, " ").trim().slice(0, 1500);
  return excerpt || null;
}

/** Detect amendment type from the filing index URL and/or document text. */
function detectAmendmentType(indexUrl: string, text: string, filingType: string): string | null {
  const isAmendment =
    /\/a\b/i.test(indexUrl) ||
    /amendment\s+no\./i.test(text) ||
    /\/A$/i.test(filingType.trim());

  if (!isAmendment) return null;

  // Determine base form type
  if (/13D/i.test(filingType)) return "SC 13D/A";
  if (/13G/i.test(filingType)) return "SC 13G/A";
  return `${filingType}/A`;
}

// ── Main export ──────────────────────────────────────────────────

/**
 * Fetch a 13D or 13G filing index, find the primary document, parse it,
 * and extract structured activist ownership data.
 *
 * All network failures and parse errors are non-fatal — partial results
 * are returned with nulls for fields that couldn't be extracted.
 */
export async function parse13DG(
  indexUrl: string,
  meta: {
    filerName: string;
    filerCik: string | null;
    accessionNo: string;
    filingDate: string;
    /** Filing type hint, e.g. "SC 13D" or "SC 13G". */
    filingType?: string;
    /** Known subject ticker from EDGAR search result. */
    subjectTicker?: string | null;
  }
): Promise<Parsed13DG> {
  const base: Parsed13DG = {
    accessionNo: meta.accessionNo,
    filerName: meta.filerName,
    filerCik: meta.filerCik,
    subjectCompanyName: "",
    subjectCompanyTicker: meta.subjectTicker ?? null,
    subjectCompanyCik: null,
    filingDate: meta.filingDate,
    percentOfClass: null,
    aggregateAmount: null,
    amendmentType: null,
    item4Excerpt: null,
    primaryDocUrl: null,
  };

  // ── Fetch the filing index page ──
  let indexHtml: string;
  try {
    const res = await secFetch(indexUrl);
    if (!res.ok) return base;
    indexHtml = await res.text();
  } catch {
    return base;
  }

  const primaryDocUrl = findPrimaryDocUrl(indexHtml, indexUrl);
  if (!primaryDocUrl) return base;

  // ── Fetch the primary document ──
  let docText: string;
  try {
    const docRes = await secFetch(primaryDocUrl);
    if (!docRes.ok) return { ...base, primaryDocUrl };
    docText = stripHtml(await docRes.text());
  } catch {
    return { ...base, primaryDocUrl };
  }

  const subjectCompanyName = extractSubjectCompanyName(docText);
  const subjectCompanyTicker = extractSubjectCompanyTicker(docText, meta.subjectTicker ?? null);
  const subjectCompanyCik = extractSubjectCompanyCik(docText);
  const percentOfClass = extractPercentOfClass(docText);
  const aggregateAmount = extractAggregateAmount(docText);
  const item4Excerpt = extractItem4Excerpt(docText);
  const amendmentType = detectAmendmentType(indexUrl, docText, meta.filingType ?? "");

  return {
    ...base,
    subjectCompanyName,
    subjectCompanyTicker,
    subjectCompanyCik,
    percentOfClass,
    aggregateAmount,
    item4Excerpt,
    amendmentType,
    primaryDocUrl,
  };
}
