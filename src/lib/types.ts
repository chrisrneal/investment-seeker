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

export type FilingSummary = {
  summary: string;
  impactRating: ImpactRating;
  flags: string[];
  modelUsed: string;
  estimatedCost: number;
  cached: boolean;
};

// ── API error shape ────────────────────────────────────────────────

export type ApiError = {
  error: string;
  detail?: string;
};
