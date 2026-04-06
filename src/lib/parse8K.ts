import { secFetch } from "./sec";
import type { ParsedForm8K } from "./types";

// ── Helpers ─────────────────────────────────────────────────────

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
 * Extract unique 8-K item numbers (e.g. "1.01", "2.02") from plain text.
 * Looks for patterns like "Item 1.01" or "ITEM 2.02".
 */
function extractItems(text: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const m of text.matchAll(/\bitem\s+(\d+\.\d+)\b/gi)) {
    const item = m[1];
    if (!seen.has(item)) {
      seen.add(item);
      items.push(item);
    }
  }
  return items;
}

/**
 * Find the URL of the primary 8-K document from the filing index HTML.
 * Looks for an <a> link in a table row whose Type column reads "8-K"
 * (exact match, excluding amendments like "8-K/A"). Falls back to the
 * first .htm link in the index if no typed match is found.
 */
function findPrimaryDocUrl(indexHtml: string, baseUrl: string): string | null {
  // EDGAR index tables have rows like: <td>1</td><td>desc</td><td><a href="...">file.htm</a></td><td>8-K</td>
  // We match each <tr> and check if it contains a "8-K" type cell.
  for (const rowMatch of indexHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1];
    if (/>\s*8-K\s*</i.test(row) && !/>\s*8-K\/A\s*</i.test(row)) {
      const hrefMatch = row.match(/href="([^"]+\.htm[l]?)"/i);
      if (hrefMatch) {
        return resolveUrl(hrefMatch[1], baseUrl);
      }
    }
  }
  // Fallback: first .htm link that isn't the index itself
  const hrefMatch = indexHtml.match(/href="([^"]+\.htm[l]?)"/i);
  return hrefMatch ? resolveUrl(hrefMatch[1], baseUrl) : null;
}

function resolveUrl(href: string, base: string): string {
  return href.startsWith("http") ? href : new URL(href, base).toString();
}

// ── Main export ──────────────────────────────────────────────────

/**
 * Fetch an 8-K filing index page, locate the primary document,
 * extract reported item numbers, and capture a plain-text excerpt.
 *
 * @param filingLink  URL of the EDGAR filing index page.
 * @param context     Metadata already known from the EDGAR search result.
 */
export async function parse8K(
  filingLink: string,
  context: {
    filerName: string;
    ticker: string | null;
    cik: string | null;
    accessionNo: string;
    filingDate: string;
  }
): Promise<ParsedForm8K> {
  const base: ParsedForm8K = {
    ...context,
    items: [],
    primaryDocUrl: null,
    textExcerpt: "",
  };

  let indexHtml: string;
  try {
    const res = await secFetch(filingLink);
    if (!res.ok) return base;
    indexHtml = await res.text();
  } catch {
    return base;
  }

  const primaryDocUrl = findPrimaryDocUrl(indexHtml, filingLink);

  let items: string[] = [];
  let textExcerpt = "";

  if (primaryDocUrl) {
    try {
      const docRes = await secFetch(primaryDocUrl);
      if (docRes.ok) {
        const docHtml = await docRes.text();
        const plainText = stripHtml(docHtml);
        items = extractItems(plainText);
        textExcerpt = plainText.slice(0, 2000);
      }
    } catch {
      // non-fatal — fall through to index-page fallback
    }
  }

  // If the primary doc fetch failed or contained no items, try the index page itself
  if (items.length === 0) {
    items = extractItems(stripHtml(indexHtml));
  }

  return { ...base, primaryDocUrl, items, textExcerpt };
}
