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
  /** +10 bonus when short float >20% and insider buying is present. */
  shortInterestBonus: number;
};

export type FundamentalsSnapshot = {
  ticker?: string;
  trailingPE: number | null;
  forwardPE?: number | null;
  revenueGrowth: number | null;
  grossMargins: number | null;
  operatingMargins?: number | null;
  totalCash: number | null;
  totalDebt?: number | null;
  debtToEquity: number | null;
  returnOnEquity?: number | null;
  shortPercentOfFloat?: number | null;
  shortRatio?: number | null;
  /** ISO 8601 timestamp of when this snapshot was fetched. */
  fetchedAt: string;
};

export type ShortInterest = {
  shortPercentOfFloat: number | null;
  shortRatio: number | null;
  fetchedAt: string;
};

export type ScoredSignal = {
  score: number;
  rationale: string;
  breakdown: SignalBreakdown;
  ticker: string;
  transactionCount: number;
  fundamentals: FundamentalsSnapshot | null;
  shortInterest: ShortInterest | null;
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

// ── 13D / 13G activist filing ─────────────────────────────────────

export type Parsed13DG = {
  accessionNo: string;
  filerName: string;
  filerCik: string | null;
  subjectCompanyName: string;
  subjectCompanyTicker: string | null;
  subjectCompanyCik: string | null;
  filingDate: string;
  percentOfClass: number | null;
  aggregateAmount: number | null;
  amendmentType: string | null;
  /** Up to 1,500 characters from Item 4 (Purpose of Transaction). */
  item4Excerpt: string | null;
  primaryDocUrl: string | null;
};

/** Supabase row shape for thirteen_dg_filings (snake_case). */
export type ThirteenDGFiling = {
  id: number;
  accession_no: string;
  filer_name: string;
  filer_cik: string | null;
  subject_company_name: string;
  subject_company_ticker: string | null;
  subject_company_cik: string | null;
  filing_date: string;
  filed_at: string;
  percent_of_class: number | null;
  aggregate_amount: number | null;
  amendment_type: string | null;
  item4_excerpt: string | null;
  primary_doc_url: string | null;
  created_at: string;
};

// ── Composite conviction score ─────────────────────────────────────

export type CompositeScoreBreakdown = {
  insiderConvictionScore: number;  // 0–40 pts
  fundamentalsScore: number;       // 0–25 pts
  valuationScore: number;          // 0–20 pts
  catalystScore: number;           // 0–15 pts
};

export type CompositeScore = {
  ticker: string;
  total: number;
  breakdown: CompositeScoreBreakdown;
  fundamentals: FundamentalsSnapshot;
  insiderSignal: ScoredSignal;
  rationale: string;
  computedAt: string;
};

// ── Annual filings ────────────────────────────────────────────────

export type AnnualFiling = {
  id: number;
  ticker: string;
  formType: '10-Q' | '10-K';
  filingDate: string;
  periodOfReport: string;
  primaryDocUrl: string;
  mdaExcerpt: string;
  createdAt: string;
};

// ── Earnings sentiment ────────────────────────────────────────────

export type EarningsSentimentResult = {
  ticker: string;
  sentimentDelta: 'improving' | 'deteriorating' | 'stable' | 'insufficient_data';
  keyThemeChanges: string[];
  redFlags: string[];
  confidenceSignals: string[];
  quarterCompared: string;
  modelUsed: string;
  estimatedCost: number;
  cached: boolean;
};

// ── Activist analysis (typed) ──────────────────────────────────────

export type ActivistThesisCategory =
  | 'Operational Improvement'
  | 'Board Reconstitution'
  | 'Strategic Sale / M&A'
  | 'Capital Return / Buyback'
  | 'Management Change'
  | 'Business Separation / Spin-off'
  | 'Balance Sheet Restructuring'
  | 'Undervaluation / Passive Accumulation';

export type ActivistAnalysisResult = {
  ticker: string;
  thesisCategory: ActivistThesisCategory;
  specificDemands: string[];
  timelineSignals: string[];
  tone: 'cooperative' | 'cautious' | 'hostile';
  catalystRisk: string;
  convergenceNote: string | null;
  filerCount: number;
  totalPercentDisclosed: number;
  oldestFilingDate: string;
  modelUsed: string;
  estimatedCost: number;
  cached: boolean;
};

// ── Risk flags ─────────────────────────────────────────────────────

export type RiskFlagSeverity = 'low' | 'medium' | 'high';

export type RiskFlag = {
  category: string;
  severity: RiskFlagSeverity;
  /** Brief quote or paraphrase from the filing (<80 chars). */
  evidence: string;
};

export type RiskFlagResult = {
  ticker: string;
  flags: RiskFlag[];
  overallRiskLevel: 'low' | 'medium' | 'high' | 'critical';
  filingScanned: string;
  modelUsed: string;
  estimatedCost: number;
  cached: boolean;
};

// ── API error shape ────────────────────────────────────────────────

export type ApiError = {
  error: string;
  detail?: string;
};
