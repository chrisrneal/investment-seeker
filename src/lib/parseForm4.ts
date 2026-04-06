import { secFetch } from "./sec";
import type {
  ParsedForm4,
  ParsedForm4Transaction,
  TransactionCode,
  TransactionType,
} from "./types";

// ── XML helpers (lightweight, no external XML lib) ─────────────────

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

function extractAllBlocks(
  xml: string,
  tag: string
): string[] {
  const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "gi");
  return xml.match(re) ?? [];
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}[^>]*\\b${attr}\\s*=\\s*"([^"]*)"`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

function num(s: string): number {
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Extract a numeric value from an SEC XML element that may use either
 * `<tag>123</tag>` or `<tag><value>123</value></tag>` patterns.
 */
function numTag(xml: string, tag: string): number {
  const inner = extractTag(xml, tag);
  if (!inner) return 0;
  // Try nested <value> first, then raw content
  const v = extractTag(inner, "value");
  return num(v || inner);
}

// ── Transaction code mapping ───────────────────────────────────────

function mapTransactionType(code: string): TransactionType {
  switch (code.toUpperCase()) {
    case "P":
      return "buy";
    case "S":
    case "F":
      return "sell";
    case "M":
    case "A":
      return "exercise";
    default:
      return "other";
  }
}

// ── Main parser ────────────────────────────────────────────────────

/**
 * Fetch and parse a Form 4 XML filing from EDGAR.
 * `url` should point to the XML primary document
 * (e.g. https://www.sec.gov/Archives/edgar/data/.../doc4.xml).
 */
export async function parseForm4(url: string): Promise<ParsedForm4> {
  const res = await secFetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch Form 4 XML: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();

  // ── Issuer info ──
  const issuerBlock = extractTag(xml, "issuer");
  const issuerName = extractTag(issuerBlock, "issuerName");
  const issuerTicker =
    extractTag(issuerBlock, "issuerTradingSymbol").toUpperCase();
  const issuerCik = extractTag(issuerBlock, "issuerCik");

  // ── Reporting owner info ──
  const ownerBlock = extractTag(xml, "reportingOwner");
  const ownerId = extractTag(ownerBlock, "reportingOwnerId");
  const officerName = extractTag(ownerId, "rptOwnerName");
  const ownerCik = extractTag(ownerId, "rptOwnerCik");

  const ownerRelationship = extractTag(ownerBlock, "reportingOwnerRelationship");
  const officerTitle =
    extractTag(ownerRelationship, "officerTitle") ||
    (extractTag(ownerRelationship, "isDirector").match(/true|1/i)
      ? "Director"
      : "Reporting Person");

  // Determine relationship type
  const relationship =
    extractTag(ownerRelationship, "isOfficer").match(/true|1/i)
      ? "officer"
      : extractTag(ownerRelationship, "isDirector").match(/true|1/i)
        ? "director"
        : extractTag(ownerRelationship, "isTenPercentOwner").match(/true|1/i)
          ? "tenPercentOwner"
          : "other";

  // ── Non-derivative transactions ──
  const ndTable = extractTag(xml, "nonDerivativeTable");
  const ndRows = extractAllBlocks(ndTable, "nonDerivativeTransaction");

  // ── Derivative transactions ──
  const dTable = extractTag(xml, "derivativeTable");
  const dRows = extractAllBlocks(dTable, "derivativeTransaction");

  const transactions: ParsedForm4Transaction[] = [];

  for (const row of ndRows) {
    const coding = extractTag(row, "transactionCoding");
    const code = extractTag(coding, "transactionCode") as TransactionCode;
    const amounts = extractTag(row, "transactionAmounts");
    const shares = numTag(amounts, "transactionShares");
    const price = numTag(amounts, "transactionPricePerShare");
    const postOwnership = extractTag(row, "postTransactionAmounts");
    const sharesOwnedAfter = numTag(postOwnership, "sharesOwnedFollowingTransaction");
    const ownershipNature = extractTag(row, "ownershipNature");
    const dirValue = extractTag(extractTag(ownershipNature, "directOrIndirectOwnership"), "value")
      || extractTag(ownershipNature, "directOrIndirectOwnership");
    const isDirect = dirValue.toUpperCase().startsWith("D");

    const txnDate = extractTag(row, "transactionDate");
    const dateValue = extractTag(txnDate, "value") || txnDate;

    transactions.push({
      officerName,
      officerTitle,
      transactionType: mapTransactionType(code),
      transactionCode: code,
      sharesTraded: shares,
      pricePerShare: price,
      totalValue: shares * price,
      sharesOwnedAfter,
      transactionDate: dateValue,
      isDirectOwnership: isDirect,
    });
  }

  for (const row of dRows) {
    const coding = extractTag(row, "transactionCoding");
    const code = extractTag(coding, "transactionCode") as TransactionCode;
    const amounts = extractTag(row, "transactionAmounts");
    const shares = numTag(amounts, "transactionShares");
    const price = numTag(amounts, "transactionPricePerShare");
    const postOwnership = extractTag(row, "postTransactionAmounts");
    const sharesOwnedAfter = numTag(postOwnership, "sharesOwnedFollowingTransaction");
    const ownershipNature = extractTag(row, "ownershipNature");
    const dirValue = extractTag(extractTag(ownershipNature, "directOrIndirectOwnership"), "value")
      || extractTag(ownershipNature, "directOrIndirectOwnership");
    const isDirect = dirValue.toUpperCase().startsWith("D");

    const txnDate = extractTag(row, "transactionDate");
    const dateValue = extractTag(txnDate, "value") || txnDate;

    transactions.push({
      officerName,
      officerTitle,
      transactionType: mapTransactionType(code),
      transactionCode: code,
      sharesTraded: shares,
      pricePerShare: price,
      totalValue: shares * price,
      sharesOwnedAfter,
      transactionDate: dateValue,
      isDirectOwnership: isDirect,
    });
  }

  // Notable = open-market buy (code "P") > $100K
  const notable = transactions.some(
    (t) => t.transactionCode === "P" && t.totalValue > 100_000
  );

  return {
    issuerName,
    issuerTicker,
    issuerCik,
    ownerCik,
    ownerName: officerName,
    ownerTitle: officerTitle,
    ownerRelationship: relationship,
    filingUrl: url,
    transactions,
    notable,
  };
}
