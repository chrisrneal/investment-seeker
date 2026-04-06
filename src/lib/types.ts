// ── Form 4 parsed transaction ──────────────────────────────────────

export type TransactionCode = "P" | "S" | "M" | "A" | "D" | "F" | "I" | "G" | "L" | "W" | "Z" | "J" | "K" | "U";

export type TransactionType = "buy" | "sell" | "exercise" | "other";

export type ParsedForm4Transaction = {
  officerName: string;
  officerTitle: string;
  transactionType: TransactionType;
  transactionCode: TransactionCode | string;
  sharesTraded: number;
  pricePerShare: number;
  totalValue: number;
  sharesOwnedAfter: number;
  transactionDate: string;
  isDirectOwnership: boolean;
};

export type ParsedForm4 = {
  issuerName: string;
  issuerTicker: string;
  issuerCik: string;
  ownerCik: string;
  ownerName: string;
  ownerTitle: string;
  ownerRelationship: string;
  filingUrl: string;
  transactions: ParsedForm4Transaction[];
  /** True when at least one open-market buy exceeds $100K. */
  notable: boolean;
};

// ── Signal scoring ─────────────────────────────────────────────────

export type SignalBreakdown = {
  clusterBuyingScore: number;
  insiderRoleScore: number;
  purchaseTypeScore: number;
  relativeHoldingsScore: number;
  priceDipScore: number;
};

export type ScoredSignal = {
  score: number;
  rationale: string;
  breakdown: SignalBreakdown;
  ticker: string;
  transactionCount: number;
};

// ── AI filing summary ──────────────────────────────────────────────

export type ImpactRating = "Positive" | "Negative" | "Neutral" | "Mixed";

export type SummaryTransaction = {
  transactionDate: string;
  transactionType: TransactionType;
  officerName: string;
  officerTitle: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  sharesOwnedAfter: number;
};

export type FilingSummary = {
  summary: string;
  impactRating: ImpactRating;
  flags: string[];
  ticker: string | null;
  issuerName: string | null;
  filingType: string | null;
  transactions: SummaryTransaction[];
  modelUsed: string;
  estimatedCost: number;
  cached: boolean;
};

// ── 8-K parsed filing ─────────────────────────────────────────────

export type ParsedForm8K = {
  filerName: string;
  ticker: string | null;
  cik: string | null;
  accessionNo: string;
  filingDate: string;
  /** Item numbers reported in the filing, e.g. ["1.01", "2.02"]. */
  items: string[];
  primaryDocUrl: string | null;
  /** First ~2000 characters of the primary document (plain text). */
  textExcerpt: string;
};

// ── 13F parsed holdings ───────────────────────────────────────────

export type Form13FHolding = {
  nameOfIssuer: string;
  cusip: string;
  /** Value in thousands of USD as reported by the SEC. */
  valueUsd: number;
  shares: number;
  investmentDiscretion: string;
  putCall: string | null;
};

export type ParsedForm13F = {
  filerCik: string | null;
  filerName: string;
  accessionNo: string;
  periodOfReport: string;
  filingDate: string;
  holdings: Form13FHolding[];
};

// ── API error shape ────────────────────────────────────────────────

export type ApiError = {
  error: string;
  detail?: string;
};
