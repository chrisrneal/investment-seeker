import { secFetch } from "./sec";
import type { FilingResult } from "./sec";

// ── Types ────────────────────────────────────────────────────────

export type Parsed13DG = {
  filerName: string;
  filerCik: string | null;
  accessionNo: string;
  filingType: string;
  filedAt: string;
  subjectTicker: string | null;
  subjectCompany: string;
  percentAcquired: number | null;
  acquisitionDate: string | null;
  /** Up to 500 characters from Item 4 of the filing. */
  purposeExcerpt: string;
  filingLink: string;
};

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
 * Prefers non-XSL .htm files. Falls back to the first .htm link.
 */
function findPrimaryDocUrl(indexHtml: string, baseUrl: string): string | null {
  // Look for a row with "SC 13" or "SC13" form type or a primary document marker
  for (const rowMatch of indexHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1];
    if (/(SC\s*13[DG]|primary\s+doc)/i.test(row) || /type.*text\/html/i.test(row)) {
      const m = row.match(/href="([^"]+\.htm[l]?)"/i);
      if (m && !/\/xsl/i.test(m[1])) {
        return m[1].startsWith("http") ? m[1] : new URL(m[1], baseUrl).toString();
      }
    }
  }
  // Fallback: first non-XSL .htm link
  for (const m of indexHtml.matchAll(/href="([^"]+\.htm[l]?)"/gi)) {
    if (!/\/xsl/i.test(m[1])) {
      return m[1].startsWith("http") ? m[1] : new URL(m[1], baseUrl).toString();
    }
  }
  return null;
}

/** Extract subject company name from plain text (Item 1 / cover page). */
function extractSubjectCompany(text: string): string {
  // Patterns for "Name of Issuer" on cover page or in Item 1
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

/** Extract subject company ticker symbol from plain text. */
function extractSubjectTicker(text: string, hintTicker: string | null): string | null {
  // Look for ticker in parens near "Common Stock", security description, or "Issuer"
  const tickerPatterns = [
    /ticker\s*(?:symbol)?[:\s]+\(?([A-Z]{1,5})\)?/i,
    /common\s+stock[^)]{0,60}\(([A-Z]{1,5})\)/i,
    /class\s+[a-z]\s+common[^)]{0,60}\(([A-Z]{1,5})\)/i,
    /\bsymbol[:\s]+([A-Z]{1,5})\b/i,
    /\b(NASDAQ|NYSE|AMEX)[:\s\/]+([A-Z]{1,5})\b/i,
    // Look for standalone ticker after issuer name
    /name\s+of\s+issuer[^(]{5,80}\(([A-Z]{1,5})\)/i,
  ];
  for (const pat of tickerPatterns) {
    const m = text.match(pat);
    if (m) {
      // Group 2 for exchange patterns, group 1 otherwise
      const tkr = (m[2] || m[1]).trim().toUpperCase();
      // Skip obvious non-tickers
      if (tkr.length >= 1 && tkr.length <= 5 && /^[A-Z]+$/.test(tkr)) {
        return tkr;
      }
    }
  }
  return hintTicker;
}

/** Extract the percent of class from plain text (Item 5 or cover page). */
function extractPercentAcquired(text: string): number | null {
  // Search for "Percent of class: X.X%" pattern first
  const patterns = [
    /percent\s+of\s+class[:\s]+(\d{1,3}(?:\.\d{1,4})?)\s*%/i,
    /(\d{1,3}(?:\.\d{1,4})?)\s*%\s+of\s+(?:the\s+)?(?:outstanding|class|total)/i,
    /aggregate\s+(?:beneficial\s+)?ownership[^%]{0,60}(\d{1,3}(?:\.\d{1,4})?)\s*%/i,
    // Row 11 on 13G cover page: "Percent of class represented..."
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

/** Extract Item 4 "Purpose of Transaction" text (up to 500 chars). */
function extractPurposeExcerpt(text: string): string {
  // Find Item 4 section
  const item4Match = text.match(
    /item\s+4[.\s]*(?:purpose\s+of\s+(?:the\s+)?transaction[^\n]*)?\n([\s\S]{10,})/i
  );
  if (!item4Match) return "";

  const after = item4Match[1];
  // Cut off at Item 5
  const item5Idx = after.search(/\bitem\s+5\b/i);
  const raw = item5Idx !== -1 ? after.slice(0, item5Idx) : after;
  return raw.replace(/\s+/g, " ").trim().slice(0, 500);
}

/** Extract acquisition date from plain text. Returns ISO date string or null. */
function extractAcquisitionDate(text: string): string | null {
  // "Date of Event" on the cover page (13D)
  const eventDateMatch = text.match(
    /date\s+of\s+(?:event\s+which\s+requires|acquisition|transaction|purchase)[:\s]+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i
  );
  if (eventDateMatch) {
    return normalizeDate(eventDateMatch[1]);
  }

  // Most recent transaction date in Item 5(c)
  const item5cMatch = text.match(
    /item\s+5[.\s]*[\s\S]{0,200}?date[s]?[:\s]+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i
  );
  if (item5cMatch) {
    return normalizeDate(item5cMatch[1]);
  }

  return null;
}

const MONTH_MAP: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

function normalizeDate(raw: string): string | null {
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();

  // "Month DD, YYYY" or "Month DD YYYY"
  const longMatch = raw.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (longMatch) {
    const monthKey = longMatch[1].toLowerCase();
    const month = MONTH_MAP[monthKey];
    if (month) {
      const day = longMatch[2].padStart(2, "0");
      return `${longMatch[3]}-${month}-${day}`;
    }
  }

  // MM/DD/YYYY or M/D/YY
  const slashMatch = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    const m = slashMatch[1].padStart(2, "0");
    const d = slashMatch[2].padStart(2, "0");
    const y = slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3];
    return `${y}-${m}-${d}`;
  }

  return null;
}

// ── Main export ──────────────────────────────────────────────────

/**
 * Fetch a 13D or 13G filing, parse the primary document, and extract
 * structured activist ownership data.
 *
 * All network failures and parse errors are non-fatal — partial results
 * are returned with empty strings / nulls for fields that couldn't be found.
 */
export async function parse13DG(
  filing: FilingResult,
): Promise<Parsed13DG> {
  const base: Parsed13DG = {
    filerName: filing.filerName,
    filerCik: filing.cik,
    accessionNo: filing.accessionNo,
    filingType: filing.filingType,
    filedAt: filing.filingDate,
    subjectTicker: filing.ticker,
    subjectCompany: "",
    percentAcquired: null,
    acquisitionDate: null,
    purposeExcerpt: "",
    filingLink: filing.link,
  };

  // ── Fetch the filing index page ──
  let indexHtml: string;
  try {
    const res = await secFetch(filing.link);
    if (!res.ok) return base;
    indexHtml = await res.text();
  } catch {
    return base;
  }

  const primaryDocUrl = findPrimaryDocUrl(indexHtml, filing.link);
  if (!primaryDocUrl) return base;

  // ── Fetch the primary document ──
  let docText: string;
  try {
    const docRes = await secFetch(primaryDocUrl);
    if (!docRes.ok) return base;
    docText = stripHtml(await docRes.text());
  } catch {
    return base;
  }

  const subjectCompany = extractSubjectCompany(docText);
  const subjectTicker = extractSubjectTicker(docText, filing.ticker);
  const percentAcquired = extractPercentAcquired(docText);
  const acquisitionDate = extractAcquisitionDate(docText);
  const purposeExcerpt = extractPurposeExcerpt(docText);

  return {
    ...base,
    subjectCompany,
    subjectTicker,
    percentAcquired,
    acquisitionDate,
    purposeExcerpt,
  };
}
