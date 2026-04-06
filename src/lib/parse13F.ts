import { secFetch } from "./sec";
import type { ParsedForm13F, Form13FHolding } from "./types";

// ── Helpers ─────────────────────────────────────────────────────

/** Extract the text content of the first matching XML tag (case-insensitive). */
function xmlText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i"));
  return m ? m[1].trim() : "";
}

/**
 * Parse all <infoTable> elements from a 13F information table XML document.
 *
 * The SEC schema uses namespace-prefixed tags in some filings (e.g. n1:infoTable)
 * and bare tags in others (infoTable). The regex handles both by allowing an
 * optional namespace prefix and matching closing tags accordingly.
 */
function parseHoldings(xml: string): Form13FHolding[] {
  const holdings: Form13FHolding[] = [];

  // Match each infoTable block (with or without namespace prefix)
  for (const m of xml.matchAll(/<(?:\w+:)?infoTable>([\s\S]*?)<\/(?:\w+:)?infoTable>/gi)) {
    const block = m[1];

    const nameOfIssuer = xmlText(block, "nameOfIssuer");
    const cusip = xmlText(block, "cusip");
    const valueRaw = xmlText(block, "value");
    const sharesRaw = xmlText(block, "sshPrnamt");
    const investmentDiscretion = xmlText(block, "investmentDiscretion");
    const putCallRaw = xmlText(block, "putCall");

    if (!cusip) continue; // skip malformed rows

    holdings.push({
      nameOfIssuer,
      cusip,
      valueUsd: parseInt(valueRaw, 10) || 0,
      shares: parseInt(sharesRaw, 10) || 0,
      investmentDiscretion: investmentDiscretion || "SOLE",
      putCall: putCallRaw || null,
    });
  }

  return holdings;
}

/**
 * Locate the information table XML document URL in the filing index HTML.
 * Checks for:
 *   1. A row whose Type column contains "INFORMATION TABLE"
 *   2. A link whose href contains "infotable" (case-insensitive)
 *   3. The first non-XSL .xml link as a last resort
 */
function findInfoTableUrl(indexHtml: string, baseUrl: string): string | null {
  for (const rowMatch of indexHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1];
    if (/information\s+table/i.test(row) || /infotable/i.test(row)) {
      const hrefMatch = row.match(/href="([^"]+)"/i);
      if (hrefMatch && !/\/xsl/i.test(hrefMatch[1])) {
        return resolveUrl(hrefMatch[1], baseUrl);
      }
    }
  }
  // Fallback: href containing "infotable" (skip XSL renderings)
  for (const m of indexHtml.matchAll(/href="([^"]*infotable[^"]*)"/gi)) {
    if (!/\/xsl/i.test(m[1])) return resolveUrl(m[1], baseUrl);
  }

  // Last resort: first non-XSL XML link
  for (const m of indexHtml.matchAll(/href="([^"]*\.xml)"/gi)) {
    const href = m[1];
    if (!href.includes("/xsl")) return resolveUrl(href, baseUrl);
  }
  return null;
}

/** Find the primary (cover) XML document URL — used to extract periodOfReport. */
function findCoverXmlUrl(indexHtml: string, baseUrl: string): string | null {
  for (const m of indexHtml.matchAll(/href="([^"]*\.xml)"/gi)) {
    const href = m[1];
    if (!href.includes("/xsl") && !/infotable/i.test(href)) {
      return resolveUrl(href, baseUrl);
    }
  }
  return null;
}

function resolveUrl(href: string, base: string): string {
  return href.startsWith("http") ? href : new URL(href, base).toString();
}

// ── Main export ──────────────────────────────────────────────────

/**
 * Fetch a 13F-HR filing index page, locate the information table XML,
 * and parse all reported holdings.
 *
 * @param filingLink  URL of the EDGAR filing index page.
 * @param context     Metadata already known from the EDGAR search result.
 */
export async function parse13F(
  filingLink: string,
  context: {
    filerName: string;
    filerCik: string | null;
    accessionNo: string;
    filingDate: string;
  }
): Promise<ParsedForm13F> {
  const base: ParsedForm13F = {
    filerCik: context.filerCik,
    filerName: context.filerName,
    accessionNo: context.accessionNo,
    periodOfReport: "",
    filingDate: context.filingDate,
    holdings: [],
  };

  let indexHtml: string;
  try {
    const res = await secFetch(filingLink);
    if (!res.ok) return base;
    indexHtml = await res.text();
  } catch {
    return base;
  }

  // ── Parse holdings from information table ──
  const infoTableUrl = findInfoTableUrl(indexHtml, filingLink);
  let holdings: Form13FHolding[] = [];

  if (infoTableUrl) {
    try {
      const xmlRes = await secFetch(infoTableUrl);
      if (xmlRes.ok) {
        holdings = parseHoldings(await xmlRes.text());
      }
    } catch {
      // non-fatal
    }
  }

  // ── Extract period of report from cover XML ──
  let periodOfReport = "";
  const coverXmlUrl = findCoverXmlUrl(indexHtml, filingLink);
  if (coverXmlUrl) {
    try {
      const coverRes = await secFetch(coverXmlUrl);
      if (coverRes.ok) {
        const coverXml = await coverRes.text();
        periodOfReport =
          xmlText(coverXml, "periodOfReport") ||
          xmlText(coverXml, "reportCalendarOrQuarter");
      }
    } catch {
      // non-fatal
    }
  }

  return { ...base, periodOfReport, holdings };
}
