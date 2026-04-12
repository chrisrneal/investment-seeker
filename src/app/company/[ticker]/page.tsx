"use client";

import { Fragment, useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import type { FilingSummary } from "@/lib/types";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import type { User, Session } from "@supabase/supabase-js";

// ── Types ──────────────────────────────────────────────────────────

type Transaction = {
  id: number;
  filingType: string;
  filingUrl: string;
  transactionDate: string;
  transactionType: string;
  transactionCode: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  sharesOwnedAfter: number;
  isDirectOwnership: boolean;
  filedAt: string;
};

type Insider = {
  cik: string;
  name: string;
  title: string;
  relationship: string;
  transactions: Transaction[];
};

type EightKEvent = {
  accessionNo: string;
  filingDate: string;
  items: string[];
  primaryDocUrl: string | null;
  textExcerpt: string;
};

type ThirteenFHolding = {
  id: number;
  accessionNo: string;
  filerName: string;
  periodOfReport: string;
  filingDate: string;
  cusip: string;
  companyName: string;
  valueUsd: number;
  shares: number;
  investmentDiscretion: string | null;
  putCall: string | null;
};

type ThirteenDGFiling = {
  id: number;
  accessionNo: string;
  filerName: string;
  filerCik: string | null;
  subjectCompanyName: string;
  subjectCompanyTicker: string | null;
  filingDate: string;
  filedAt: string;
  percentOfClass: number | null;
  aggregateAmount: number | null;
  amendmentType: string | null;
  item4Excerpt: string | null;
  primaryDocUrl: string | null;
};

type ActivistAnalysis = {
  thesisCategory: string;
  specificDemands: string[];
  timelineSignals: string[];
  tone: "cooperative" | "cautious" | "hostile";
  catalystRisk: string;
  convergenceNote: string | null;
  filerCount: number;
  totalPercentDisclosed: number;
  oldestFilingDate: string;
  modelUsed: string;
  estimatedCost: number;
  cached: boolean;
};

type CompositeScoreData = {
  ticker: string;
  total: number;
  breakdown: {
    insiderConvictionScore: number;
    fundamentalsScore: number;
    valuationScore: number;
    catalystScore: number;
  };
  fundamentals: {
    trailingPE?: number | null;
    forwardPE?: number | null;
    revenueGrowth?: number | null;
    grossMargins?: number | null;
    debtToEquity?: number | null;
    shortPercentOfFloat?: number | null;
    shortRatio?: number | null;
  };
  insiderSignal: { score: number; rationale: string };
  rationale: string;
  computedAt: string;
  cached: boolean;
};

type EarningsSentimentData = {
  ticker: string;
  sentimentDelta: "improving" | "deteriorating" | "stable" | "insufficient_data";
  keyThemeChanges: string[];
  redFlags: string[];
  confidenceSignals: string[];
  quarterCompared: string;
  modelUsed: string;
  estimatedCost: number;
  cached: boolean;
};

type RiskFlagData = {
  ticker: string;
  flags: Array<{ category: string; severity: "low" | "medium" | "high"; evidence: string }>;
  overallRiskLevel: "low" | "medium" | "high" | "critical";
  filingScanned: string;
  modelUsed: string;
  estimatedCost: number;
  cached: boolean;
};

type AnnualFiling = {
  id: number;
  formType: string;
  filingDate: string;
  periodOfReport: string | null;
  primaryDocUrl: string | null;
  mdaExcerpt: string;
};

type FundamentalsData = {
  trailingPE: number | null;
  revenueGrowth: number | null;
  grossMargins: number | null;
  totalCash: number | null;
  debtToEquity: number | null;
  fetchedAt: string;
};

type ShortInterestData = {
  shortPercentOfFloat: number | null;
  shortRatio: number | null;
  fetchedAt: string;
};

type SignalBreakdown = {
  clusterBuyingScore: number;
  insiderRoleScore: number;
  purchaseTypeScore: number;
  relativeHoldingsScore: number;
  priceDipScore: number;
  shortInterestBonus: number;
};

type SignalScoreData = {
  score: number;
  rationale: string;
  breakdown: SignalBreakdown;
  ticker: string;
  transactionCount: number;
  fundamentals: FundamentalsData | null;
  shortInterest: ShortInterestData | null;
};

type Company = {
  cik: string;
  name: string;
  ticker: string | null;
  latestTransactionDate: string | null;
  insiders: Insider[];
  eightKEvents?: EightKEvent[];
  thirteenFHoldings?: ThirteenFHolding[];
  thirteenDGFilings?: ThirteenDGFiling[];
  annualFilings?: AnnualFiling[];
};

// ── Styles ─────────────────────────────────────────────────────────

const panel: React.CSSProperties = {
  border: "1px solid #1e2832",
  borderRadius: 12,
  padding: 20,
  background: "#0e151d",
};

const insiderBlock: React.CSSProperties = {
  marginTop: 10,
  padding: "10px 12px",
  background: "#0c1218",
  borderRadius: 8,
  border: "1px solid #1a2530",
};

const btn = (bg: string): React.CSSProperties => ({
  padding: "10px 16px",
  borderRadius: 8,
  border: "none",
  fontWeight: 600,
  cursor: "pointer",
  background: bg,
  color: "#fff",
});

const badge = (bg: string): React.CSSProperties => ({
  display: "inline-block",
  padding: "2px 10px",
  borderRadius: 999,
  fontSize: 12,
  background: bg,
  color: "#e6e8eb",
});

const txnColor: Record<string, string> = {
  buy: "#1a5a3a",
  sell: "#5a1a1a",
  exercise: "#3a3a1a",
  other: "#2a2a3a",
};

const impactBg: Record<string, string> = {
  Positive: "#0d2d1a",
  Negative: "#2d0d0d",
  Mixed: "#2a2000",
  Neutral: "#1a2030",
};

const impactText: Record<string, string> = {
  Positive: "#6ecf8a",
  Negative: "#ff8a8a",
  Mixed: "#ffd080",
  Neutral: "#9aa4ad",
};

// ── Lightweight Markdown renderer ──────────────────────────────────

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const sizes = [18, 16, 14, 13];
      elements.push(
        <div key={key++} style={{ fontWeight: 700, fontSize: sizes[level - 1], color: "#e6e8eb", margin: "10px 0 4px" }}>
          {inlineMarkdown(headingMatch[2])}
        </div>
      );
      i++;
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(line)) {
      elements.push(<hr key={key++} style={{ border: "none", borderTop: "1px solid #1e2832", margin: "10px 0" }} />);
      i++;
      continue;
    }

    if (/^\s*[-*+]\s/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) {
        items.push(<li key={items.length}>{inlineMarkdown(lines[i].replace(/^\s*[-*+]\s/, ""))}</li>);
        i++;
      }
      elements.push(<ul key={key++} style={{ margin: "6px 0", paddingLeft: 20, lineHeight: 1.7 }}>{items}</ul>);
      continue;
    }

    if (/^\s*\d+[.)]\s/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) {
        items.push(<li key={items.length}>{inlineMarkdown(lines[i].replace(/^\s*\d+[.)]\s/, ""))}</li>);
        i++;
      }
      elements.push(<ol key={key++} style={{ margin: "6px 0", paddingLeft: 20, lineHeight: 1.7 }}>{items}</ol>);
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^#{1,4}\s/) &&
      !/^\s*[-*+]\s/.test(lines[i]) &&
      !/^\s*\d+[.)]\s/.test(lines[i]) &&
      !/^[-*_]{3,}\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      elements.push(
        <p key={key++} style={{ margin: "6px 0", lineHeight: 1.65 }}>
          {inlineMarkdown(paraLines.join(" "))}
        </p>
      );
    }
  }

  return elements;
}

function inlineMarkdown(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let k = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(<strong key={k++} style={{ color: "#e6e8eb", fontWeight: 600 }}>{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={k++}>{match[3]}</em>);
    } else if (match[4]) {
      parts.push(
        <code key={k++} style={{ background: "#1a2530", padding: "1px 5px", borderRadius: 3, fontSize: "0.9em", color: "#7cc4ff" }}>
          {match[4]}
        </code>
      );
    } else if (match[5] && match[6]) {
      parts.push(
        <a key={k++} href={match[6]} target="_blank" rel="noopener noreferrer" style={{ color: "#7cc4ff", textDecoration: "underline" }}>
          {match[5]}
        </a>
      );
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length === 1 ? parts[0] : parts;
}

// ── SummaryPanel ───────────────────────────────────────────────────

function SummaryPanel({
  summary,
  isDeep,
  onDeepAnalysis,
}: {
  summary: FilingSummary;
  isDeep: boolean;
  onDeepAnalysis?: () => void;
}) {
  return (
    <div
      style={{
        padding: "12px 14px",
        background: "#090e14",
        borderTop: "1px solid #1a2530",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            ...badge(impactBg[summary.impactRating] ?? "#1a2030"),
            color: impactText[summary.impactRating] ?? "#9aa4ad",
            fontWeight: 700,
          }}
        >
          {summary.impactRating}
        </span>
        {summary.issuerName && (
          <span style={{ color: "#9aa4ad", fontSize: 12 }}>{summary.issuerName}</span>
        )}
        {summary.ticker && (
          <span style={{ color: "#7cc4ff", fontSize: 12, fontWeight: 600 }}>
            {summary.ticker}
          </span>
        )}
        {summary.filingType && (
          <span style={{ ...badge("#1e2832"), fontSize: 11 }}>{summary.filingType}</span>
        )}
        {isDeep ? (
          <span
            style={{
              ...badge("#1a2a1a"),
              marginLeft: "auto",
              fontSize: 11,
              color: "#6ecf8a",
            }}
          >
            🔬 deep
          </span>
        ) : (
          onDeepAnalysis && (
            <button
              onClick={onDeepAnalysis}
              style={{
                ...btn("#1a2a1a"),
                padding: "2px 10px",
                fontSize: 11,
                fontWeight: 500,
                marginLeft: "auto",
              }}
            >
              🔬 Deep Analysis
            </button>
          )
        )}
      </div>

      <div
        style={{
          color: "#c8d4e0",
          fontSize: 13,
          lineHeight: 1.65,
          margin: "0 0 10px",
        }}
      >
        {renderMarkdown(summary.summary)}
      </div>

      {summary.flags.length > 0 && (
        <ul
          style={{
            color: "#ffd080",
            fontSize: 12,
            margin: "0 0 10px",
            paddingLeft: 18,
            lineHeight: 1.7,
          }}
        >
          {summary.flags.map((flag, i) => (
            <li key={i}>{inlineMarkdown(flag)}</li>
          ))}
        </ul>
      )}

      {summary.transactions.length > 0 && (
        <div style={{ marginBottom: 10, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr
                style={{
                  color: "#7a8a9a",
                  textAlign: "left",
                  borderBottom: "1px solid #1e2832",
                }}
              >
                <th style={{ padding: "3px 6px" }}>Officer</th>
                <th style={{ padding: "3px 6px" }}>Date</th>
                <th style={{ padding: "3px 6px" }}>Type</th>
                <th style={{ padding: "3px 6px", textAlign: "right" }}>Shares</th>
                <th style={{ padding: "3px 6px", textAlign: "right" }}>Price</th>
                <th style={{ padding: "3px 6px", textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {summary.transactions.map((st, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #141e28" }}>
                  <td style={{ padding: "3px 6px", color: "#c8d4e0" }}>
                    {st.officerName}
                  </td>
                  <td
                    style={{
                      padding: "3px 6px",
                      color: "#9aa4ad",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {st.transactionDate}
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <span style={badge(txnColor[st.transactionType] ?? txnColor.other)}>
                      {st.transactionType}
                    </span>
                  </td>
                  <td
                    style={{
                      padding: "3px 6px",
                      textAlign: "right",
                      color: "#c8d4e0",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {Number(st.shares).toLocaleString()}
                  </td>
                  <td
                    style={{
                      padding: "3px 6px",
                      textAlign: "right",
                      color: "#c8d4e0",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    ${Number(st.pricePerShare).toFixed(2)}
                  </td>
                  <td
                    style={{
                      padding: "3px 6px",
                      textAlign: "right",
                      color: "#c8d4e0",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    $
                    {Number(st.totalValue).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div
        style={{
          color: "#4a5a6a",
          fontSize: 11,
          display: "flex",
          gap: 6,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span>{summary.modelUsed}</span>
        <span>·</span>
        <span>${summary.estimatedCost.toFixed(6)}</span>
        {summary.cached && (
          <>
            <span>·</span>
            <span style={{ color: "#7cc4ff" }}>⚡ cached</span>
          </>
        )}
      </div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────

export default function CompanyPage() {
  const { ticker } = useParams<{ ticker: string }>();

  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [activeTab, setActiveTab] = useState<string>("insiders");
  const [fundamentals, setFundamentals] = useState<FundamentalsData | null>(null);
  const [shortInterest, setShortInterest] = useState<ShortInterestData | null>(null);
  const [signalScore, setSignalScore] = useState<SignalScoreData | null>(null);

  // ── Auth state ─────────────────────────────────────────────────
  const supabaseRef = useRef(getSupabaseBrowserClient());
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    const sb = supabaseRef.current;
    sb.auth.getSession().then(({ data: { session } }: { data: { session: Session | null } }) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
    const { data: { subscription } } = sb.auth.onAuthStateChange(
      (_event: string, session: Session | null) => {
        setUser(session?.user ?? null);
      }
    );
    return () => subscription.unsubscribe();
  }, []);

  async function handleAuth(e: React.FormEvent) {
    e.preventDefault();
    setAuthError("");
    const sb = supabaseRef.current;
    const { error } = await sb.auth.signInWithPassword({ email: authEmail, password: authPassword });
    if (error) { setAuthError(error.message); return; }
    setAuthEmail("");
    setAuthPassword("");
  }

  async function handleLogout() {
    await supabaseRef.current.auth.signOut();
  }

  const isAuthenticated = !!user;

  // ── Summary state ──────────────────────────────────────────────
  const [summaries, setSummaries] = useState<Map<string, FilingSummary>>(new Map());
  const [summaryLoading, setSummaryLoading] = useState<Set<string>>(new Set());
  const [summaryErrors, setSummaryErrors] = useState<Map<string, string>>(new Map());
  const [expandedSummaries, setExpandedSummaries] = useState<Set<number>>(new Set());
  const [deepUrls, setDeepUrls] = useState<Set<string>>(new Set());
  const [companySummarizing, setCompanySummarizing] = useState(false);

  // ── Activist analysis state ────────────────────────────────────
  const [activistAnalysis, setActivistAnalysis] = useState<ActivistAnalysis | null>(null);
  const [activistLoading, setActivistLoading] = useState(false);
  const [activistError, setActivistError] = useState("");
  const [activistExpanded, setActivistExpanded] = useState(false);
  const [expandedItem4, setExpandedItem4] = useState<Set<number>>(new Set());
  const [expanded8K, setExpanded8K] = useState<Set<string>>(new Set());

  // ── Composite Score state ──────────────────────────────────────
  const [compositeScore, setCompositeScore] = useState<CompositeScoreData | null>(null);
  const [compositeLoading, setCompositeLoading] = useState(false);
  const [compositeError, setCompositeError] = useState("");

  // ── Earnings Sentiment state ───────────────────────────────────
  const [earningsSentiment, setEarningsSentiment] = useState<EarningsSentimentData | null>(null);
  const [earningsSentimentPhase, setEarningsSentimentPhase] = useState<"idle" | "ingesting" | "analyzing">("idle");
  const [earningsSentimentError, setEarningsSentimentError] = useState("");

  // ── Risk Flags state ───────────────────────────────────────────
  const [riskFlags, setRiskFlags] = useState<RiskFlagData | null>(null);
  const [riskFlagsLoading, setRiskFlagsLoading] = useState(false);
  const [riskFlagsError, setRiskFlagsError] = useState("");
  const [expandedRiskFlag, setExpandedRiskFlag] = useState<Set<number>>(new Set());

  // ── Load company data ──────────────────────────────────────────

  const loadCompany = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`/api/companies/${encodeURIComponent(ticker)}`);
      const data = await res.json();

      if (res.status === 404) {
        setLoadError(`No data found for "${ticker.toUpperCase()}". Search for this ticker on the home page to ingest its filings.`);
        return;
      }

      if (!res.ok || data.error) throw new Error(data.error ?? "Failed to load company");

      setCompany(data.company ?? null);
      setFundamentals(data.fundamentals ?? null);
      setShortInterest(data.shortInterest ?? null);
      setSignalScore(data.signalScore ?? null);

      // Pre-populate cached summaries
      if (data.summaries && typeof data.summaries === "object") {
        const cached = data.summaries as Record<string, FilingSummary>;
        const cachedUrls = new Set(Object.keys(cached));

        setSummaries((prev) => {
          const next = new Map(prev);
          for (const [url, summary] of Object.entries(cached)) {
            if (!next.has(url)) {
              next.set(url, summary);
            }
          }
          return next;
        });

        // Auto-expand rows with cached summaries
        if (data.company) {
          const co = data.company as Company;
          const autoExpand = new Set<number>();
          for (const ins of co.insiders) {
            for (const t of ins.transactions) {
              if (cachedUrls.has(t.filingUrl)) {
                autoExpand.add(t.id);
              }
            }
          }
          if (autoExpand.size > 0) {
            setExpandedSummaries((prev) => {
              const next = new Set(prev);
              for (const id of autoExpand) next.add(id);
              return next;
            });
          }
        }
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [ticker]);

  useEffect(() => {
    loadCompany();
  }, [loadCompany]);

  // ── Summary actions ────────────────────────────────────────────

  async function fetchSummary(filingUrl: string, filingType: string, deep = false) {
    if (summaryLoading.has(filingUrl)) return;

    setSummaryLoading((prev) => {
      const next = new Set(prev);
      next.add(filingUrl);
      return next;
    });
    setSummaryErrors((prev) => {
      const next = new Map(prev);
      next.delete(filingUrl);
      return next;
    });

    try {
      const params = new URLSearchParams({ url: filingUrl, filing_type: filingType });
      if (deep) params.set("deep_analysis", "true");
      const res = await fetch(`/api/summarize?${params}`);
      const data: FilingSummary & { error?: string } = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Summary failed");
      setSummaries((prev) => {
        const next = new Map(prev);
        next.set(filingUrl, data);
        return next;
      });
      setDeepUrls((prev) => {
        const next = new Set(prev);
        if (deep) next.add(filingUrl);
        else next.delete(filingUrl);
        return next;
      });
    } catch (e) {
      setSummaryErrors((prev) => {
        const next = new Map(prev);
        next.set(filingUrl, e instanceof Error ? e.message : "Unknown error");
        return next;
      });
    } finally {
      setSummaryLoading((prev) => {
        const next = new Set(prev);
        next.delete(filingUrl);
        return next;
      });
    }
  }

  function handleSummarize(
    txnId: number,
    filingUrl: string,
    filingType: string,
    deep = false,
  ) {
    const isOpen = expandedSummaries.has(txnId);
    const hasLoaded = summaries.has(filingUrl);
    const currentIsDeep = deepUrls.has(filingUrl);
    const isLoading = summaryLoading.has(filingUrl);

    if (isOpen && hasLoaded && currentIsDeep === deep && !isLoading) {
      setExpandedSummaries((prev) => {
        const next = new Set(prev);
        next.delete(txnId);
        return next;
      });
      return;
    }

    setExpandedSummaries((prev) => {
      const next = new Set(prev);
      next.add(txnId);
      return next;
    });

    if ((!hasLoaded || currentIsDeep !== deep) && !isLoading) {
      void fetchSummary(filingUrl, filingType, deep);
    }
  }

  async function summarizeAll() {
    if (!company) return;
    setCompanySummarizing(true);

    const seenUrls = new Set<string>();
    const toFetch: { url: string; filingType: string }[] = [];
    for (const insider of company.insiders) {
      if (insider.transactions.length > 0) {
        const t = insider.transactions[0];
        if (
          !seenUrls.has(t.filingUrl) &&
          !summaries.has(t.filingUrl) &&
          !summaryLoading.has(t.filingUrl)
        ) {
          seenUrls.add(t.filingUrl);
          toFetch.push({ url: t.filingUrl, filingType: t.filingType });
        }
      }
    }

    const CONCURRENCY = 3;
    for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
      const batch = toFetch.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(({ url, filingType }) => fetchSummary(url, filingType)));
    }

    setCompanySummarizing(false);
  }

  async function fetchActivistAnalysis() {
    if (activistLoading) return;
    if (activistAnalysis && activistExpanded) {
      setActivistExpanded(false);
      return;
    }
    if (activistAnalysis) {
      setActivistExpanded(true);
      return;
    }
    setActivistLoading(true);
    setActivistError("");
    setActivistExpanded(true);
    try {
      const res = await fetch(`/api/analyze/activist?ticker=${encodeURIComponent(ticker)}`);
      const data: ActivistAnalysis & { error?: string } = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Analysis failed");
      setActivistAnalysis(data);
    } catch (e) {
      setActivistError(e instanceof Error ? e.message : "Unknown error");
      setActivistExpanded(false);
    } finally {
      setActivistLoading(false);
    }
  }

  async function refreshCompositeScore() {
    setCompositeScore(null);
    await fetchCompositeScore();
  }

  async function fetchCompositeScore() {
    if (compositeLoading) return;
    setCompositeLoading(true);
    setCompositeError("");
    try {
      const res = await fetch(`/api/signal/composite?ticker=${encodeURIComponent(ticker)}`);
      const data: CompositeScoreData & { error?: string } = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Score failed");
      setCompositeScore(data);
    } catch (e) {
      setCompositeError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setCompositeLoading(false);
    }
  }

  async function fetchEarningsSentiment() {
    if (earningsSentimentPhase !== "idle") return;
    setEarningsSentimentError("");
    // Phase 1: ingest filings
    setEarningsSentimentPhase("ingesting");
    try {
      await fetch(`/api/filings/annual?ticker=${encodeURIComponent(ticker)}`, { method: "POST" });
    } catch {
      // Non-fatal — continue to analysis even if ingest partially fails.
    }
    // Phase 2: analyze
    setEarningsSentimentPhase("analyzing");
    try {
      const res = await fetch(`/api/analyze/earnings-sentiment?ticker=${encodeURIComponent(ticker)}`);
      const data: EarningsSentimentData & { error?: string } = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Analysis failed");
      setEarningsSentiment(data);
    } catch (e) {
      setEarningsSentimentError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setEarningsSentimentPhase("idle");
    }
  }

  async function fetchRiskFlags() {
    if (riskFlagsLoading) return;
    setRiskFlagsLoading(true);
    setRiskFlagsError("");
    try {
      // Ensure filings are ingested first.
      await fetch(`/api/filings/annual?ticker=${encodeURIComponent(ticker)}`, { method: "POST" });
      const res = await fetch(`/api/analyze/risk-flags?ticker=${encodeURIComponent(ticker)}`);
      const data: RiskFlagData & { error?: string } = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Scan failed");
      setRiskFlags(data);
    } catch (e) {
      setRiskFlagsError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setRiskFlagsLoading(false);
    }
  }

  // ── Computed values ────────────────────────────────────────────

  const totalInsiders = company?.insiders.length ?? 0;
  const totalTxns = company?.insiders.reduce(
    (n, i) => n + i.transactions.length, 0,
  ) ?? 0;
  const eightKEventsCount = company?.eightKEvents?.length ?? 0;
  const thirteenFHoldingsCount = company?.thirteenFHoldings?.length ?? 0;
  const thirteenDGCount = company?.thirteenDGFilings?.length ?? 0;
  const annualFilingsCount = company?.annualFilings?.length ?? 0;

  // Collect unique loaded summaries for overview block
  const companySummaryEntries = (() => {
    if (!company) return [];
    const seenUrls = new Set<string>();
    const entries: { url: string; summary: FilingSummary }[] = [];
    for (const insider of company.insiders) {
      for (const t of insider.transactions) {
        if (!seenUrls.has(t.filingUrl) && summaries.has(t.filingUrl)) {
          seenUrls.add(t.filingUrl);
          entries.push({ url: t.filingUrl, summary: summaries.get(t.filingUrl)! });
        }
      }
    }
    return entries;
  })();

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "40px 20px 80px" }}>
      {/* ── Header ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
            <a
              href="/"
              style={{
                color: "#7cc4ff",
                textDecoration: "none",
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              ← Back
            </a>
          </div>
          {loading ? (
            <h1 style={{ fontSize: 28, margin: 0 }}>Loading…</h1>
          ) : company ? (
            <>
              <h1 style={{ fontSize: 28, margin: 0 }}>
                {company.name}
                {company.ticker && (
                  <span style={{ color: "#7cc4ff", marginLeft: 12, fontWeight: 600 }}>
                    {company.ticker}
                  </span>
                )}
              </h1>
              <p style={{ color: "#9aa4ad", marginTop: 4 }}>
                CIK: {company.cik}
                {company.latestTransactionDate && (
                  <span style={{ marginLeft: 16 }}>Latest transaction: {company.latestTransactionDate}</span>
                )}
              </p>
              {/* Signal Score + Key Metrics */}
              {(signalScore || fundamentals || shortInterest) && (
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 12, alignItems: "flex-start" }}>
                  {signalScore && (
                    <div style={{
                      padding: "10px 16px", borderRadius: 10,
                      background: signalScore.score >= 60 ? "#0d2d1a" : signalScore.score >= 30 ? "#2a2000" : "#1a2030",
                      border: `1px solid ${signalScore.score >= 60 ? "#1a5a3a" : signalScore.score >= 30 ? "#5a4a1a" : "#2a3a4a"}`,
                      minWidth: 110, textAlign: "center",
                    }}>
                      <div style={{
                        fontSize: 28, fontWeight: 800, fontVariantNumeric: "tabular-nums",
                        color: signalScore.score >= 60 ? "#6ecf8a" : signalScore.score >= 30 ? "#ffd080" : "#9aa4ad",
                      }}>
                        {signalScore.score}
                      </div>
                      <div style={{ fontSize: 10, color: "#7a8a9a", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
                        Signal Score
                      </div>
                      <div style={{ fontSize: 11, color: "#4a5a6a", marginTop: 2 }}>
                        {signalScore.transactionCount} txn{signalScore.transactionCount !== 1 ? "s" : ""}
                      </div>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", flex: 1 }}>
                    {fundamentals && (
                      <div style={{
                        padding: "8px 14px", borderRadius: 8, background: "#0c1218",
                        border: "1px solid #1a2530", fontSize: 12, lineHeight: 1.8,
                      }}>
                        <div style={{ fontSize: 10, color: "#7a8a9a", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, marginBottom: 2 }}>
                          Fundamentals
                        </div>
                        {fundamentals.trailingPE != null && (
                          <div><span style={{ color: "#7a8a9a" }}>P/E:</span>{" "}
                            <span style={{ color: "#c8d4e0", fontWeight: 600 }}>{fundamentals.trailingPE.toFixed(1)}</span>
                          </div>
                        )}
                        {fundamentals.revenueGrowth != null && (
                          <div><span style={{ color: "#7a8a9a" }}>Rev Growth:</span>{" "}
                            <span style={{ color: fundamentals.revenueGrowth >= 0 ? "#6ecf8a" : "#ff8a8a", fontWeight: 600 }}>
                              {(fundamentals.revenueGrowth * 100).toFixed(1)}%
                            </span>
                          </div>
                        )}
                        {fundamentals.grossMargins != null && (
                          <div><span style={{ color: "#7a8a9a" }}>Gross Margin:</span>{" "}
                            <span style={{ color: "#c8d4e0", fontWeight: 600 }}>{(fundamentals.grossMargins * 100).toFixed(1)}%</span>
                          </div>
                        )}
                        {fundamentals.totalCash != null && (
                          <div><span style={{ color: "#7a8a9a" }}>Cash:</span>{" "}
                            <span style={{ color: "#c8d4e0", fontWeight: 600 }}>
                              ${fundamentals.totalCash >= 1e9
                                ? (fundamentals.totalCash / 1e9).toFixed(1) + "B"
                                : fundamentals.totalCash >= 1e6
                                  ? (fundamentals.totalCash / 1e6).toFixed(0) + "M"
                                  : fundamentals.totalCash.toLocaleString()}
                            </span>
                          </div>
                        )}
                        {fundamentals.debtToEquity != null && (
                          <div><span style={{ color: "#7a8a9a" }}>D/E:</span>{" "}
                            <span style={{ color: fundamentals.debtToEquity > 100 ? "#ff8a8a" : "#c8d4e0", fontWeight: 600 }}>
                              {fundamentals.debtToEquity.toFixed(1)}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                    {shortInterest && (shortInterest.shortPercentOfFloat != null || shortInterest.shortRatio != null) && (
                      <div style={{
                        padding: "8px 14px", borderRadius: 8, background: "#0c1218",
                        border: "1px solid #1a2530", fontSize: 12, lineHeight: 1.8,
                      }}>
                        <div style={{ fontSize: 10, color: "#7a8a9a", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, marginBottom: 2 }}>
                          Short Interest
                        </div>
                        {shortInterest.shortPercentOfFloat != null && (
                          <div><span style={{ color: "#7a8a9a" }}>% of Float:</span>{" "}
                            <span style={{
                              color: shortInterest.shortPercentOfFloat > 0.20 ? "#ff8a8a"
                                : shortInterest.shortPercentOfFloat > 0.10 ? "#ffd080" : "#c8d4e0",
                              fontWeight: 600,
                            }}>
                              {(shortInterest.shortPercentOfFloat * 100).toFixed(1)}%
                            </span>
                          </div>
                        )}
                        {shortInterest.shortRatio != null && (
                          <div><span style={{ color: "#7a8a9a" }}>Days to Cover:</span>{" "}
                            <span style={{ color: "#c8d4e0", fontWeight: 600 }}>{shortInterest.shortRatio.toFixed(1)}</span>
                          </div>
                        )}
                      </div>
                    )}
                    {signalScore && (
                      <div style={{
                        padding: "8px 14px", borderRadius: 8, background: "#0c1218",
                        border: "1px solid #1a2530", fontSize: 12, lineHeight: 1.8, minWidth: 160,
                      }}>
                        <div style={{ fontSize: 10, color: "#7a8a9a", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, marginBottom: 2 }}>
                          Score Breakdown
                        </div>
                        <div><span style={{ color: "#7a8a9a" }}>Cluster Buying:</span>{" "}
                          <span style={{ color: "#c8d4e0" }}>{signalScore.breakdown.clusterBuyingScore}/25</span>
                        </div>
                        <div><span style={{ color: "#7a8a9a" }}>Insider Role:</span>{" "}
                          <span style={{ color: "#c8d4e0" }}>{signalScore.breakdown.insiderRoleScore}/20</span>
                        </div>
                        <div><span style={{ color: "#7a8a9a" }}>Purchase Type:</span>{" "}
                          <span style={{ color: "#c8d4e0" }}>{signalScore.breakdown.purchaseTypeScore}/25</span>
                        </div>
                        <div><span style={{ color: "#7a8a9a" }}>Holdings:</span>{" "}
                          <span style={{ color: "#c8d4e0" }}>{signalScore.breakdown.relativeHoldingsScore}/15</span>
                        </div>
                        <div><span style={{ color: "#7a8a9a" }}>Price Dip:</span>{" "}
                          <span style={{ color: "#c8d4e0" }}>{signalScore.breakdown.priceDipScore}/15</span>
                        </div>
                        {signalScore.breakdown.shortInterestBonus > 0 && (
                          <div><span style={{ color: "#7a8a9a" }}>Short Squeeze:</span>{" "}
                            <span style={{ color: "#ffd080" }}>+{signalScore.breakdown.shortInterestBonus}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {signalScore && signalScore.rationale && (
                <p style={{ color: "#9aa4ad", fontSize: 12, marginTop: 8, lineHeight: 1.6 }}>
                  {signalScore.rationale}
                </p>
              )}
            </>
          ) : (
            <h1 style={{ fontSize: 28, margin: 0 }}>Company Not Found</h1>
          )}
        </div>
        {/* ── Auth Bar ── */}
        {!authLoading && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            {user ? (
              <>
                <span style={{ color: "#9aa4ad", fontSize: 13 }}>{user.email}</span>
                <button onClick={handleLogout} style={{ ...btn("#2e3a4a"), padding: "6px 12px", fontSize: 12 }}>
                  Sign Out
                </button>
              </>
            ) : (
              <form onSubmit={handleAuth} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  type="email"
                  placeholder="Email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  required
                  style={{
                    padding: "6px 10px", borderRadius: 6, border: "1px solid #2a3a4a",
                    background: "#0e151d", color: "#e6e8eb", fontSize: 13, width: 160,
                  }}
                />
                <input
                  type="password"
                  placeholder="Password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  required
                  minLength={6}
                  style={{
                    padding: "6px 10px", borderRadius: 6, border: "1px solid #2a3a4a",
                    background: "#0e151d", color: "#e6e8eb", fontSize: 13, width: 130,
                  }}
                />
                <button type="submit" style={{ ...btn("#1a6dd4"), padding: "6px 12px", fontSize: 12 }}>
                  Sign In
                </button>
              </form>
            )}
          </div>
        )}
      </div>
      {authError && <p style={{ color: "#ff8a8a", fontSize: 13, margin: "6px 0 0" }}>{authError}</p>}

      {/* ── Error ── */}
      {loadError && (
        <div style={{ ...panel, marginTop: 24 }}>
          <p style={{ color: "#ff8a8a", margin: 0 }}>{loadError}</p>
        </div>
      )}

      {/* ── Company Details ── */}
      {company && (
        <section style={{ ...panel, marginTop: 24 }}>
          {/* Stats row */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            <span style={badge("#1e2832")}>
              {totalInsiders} insider{totalInsiders !== 1 ? "s" : ""}
            </span>
            <span style={badge("#1e2832")}>
              {totalTxns} txn{totalTxns !== 1 ? "s" : ""}
            </span>
            {eightKEventsCount > 0 && (
              <span style={badge("#1e2832")}>
                {eightKEventsCount} 8-K
              </span>
            )}
            {thirteenFHoldingsCount > 0 && (
              <span style={badge("#1e2832")}>
                {thirteenFHoldingsCount} 13F
              </span>
            )}
            {thirteenDGCount > 0 && (
              <span style={badge("#2a1a3a")}>
                {thirteenDGCount} activist
              </span>
            )}
            {annualFilingsCount > 0 && (
              <span style={badge("#1e2832")}>
                {annualFilingsCount} 10-Q/K
              </span>
            )}
          </div>

          {/* ── Composite Score Card ── */}
          {(compositeScore || compositeLoading || compositeError) && (
            <div style={{ marginBottom: 14, padding: "14px 16px", background: "#090e14", borderRadius: 8, border: "1px solid #1e2832" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "#7a8a9a", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
                  Composite Conviction Score
                </span>
                {compositeScore && (
                  <button
                    onClick={() => void refreshCompositeScore()}
                    disabled={compositeLoading || !isAuthenticated}
                    title={isAuthenticated ? "Refresh composite score" : "Sign in to use AI features"}
                    style={{ ...btn("#1e2832"), padding: "2px 8px", fontSize: 11, marginLeft: "auto", opacity: compositeLoading || !isAuthenticated ? 0.5 : 1 }}
                  >
                    {compositeLoading ? "…" : "↺ Refresh"}
                  </button>
                )}
              </div>
              {compositeLoading && !compositeScore && (
                <p style={{ color: "#7a8a9a", fontSize: 13, margin: 0 }}>Computing composite score…</p>
              )}
              {compositeError && !compositeScore && (
                <p style={{ color: "#ff8a8a", fontSize: 13, margin: 0 }}>{compositeError}</p>
              )}
              {compositeScore && (() => {
                const { total, breakdown, fundamentals: f, rationale, cached: cs } = compositeScore;
                const scoreBg = total >= 75 ? "#0d2d1a" : total >= 50 ? "#2a2000" : total >= 25 ? "#2a1a00" : "#1a2030";
                const scoreColor = total >= 75 ? "#6ecf8a" : total >= 50 ? "#ffd080" : total >= 25 ? "#ff8a8a" : "#9aa4ad";
                const scoreBorder = total >= 75 ? "#1a5a3a" : total >= 50 ? "#5a4a1a" : total >= 25 ? "#5a2a1a" : "#2a3a4a";
                const shortFloat = f?.shortPercentOfFloat ?? null;
                return (
                  <div>
                    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
                      {/* Score badge */}
                      <div style={{ padding: "10px 16px", borderRadius: 10, background: scoreBg, border: `1px solid ${scoreBorder}`, minWidth: 100, textAlign: "center", flexShrink: 0 }}>
                        <div style={{ fontSize: 32, fontWeight: 800, color: scoreColor, fontVariantNumeric: "tabular-nums" }}>{total}</div>
                        <div style={{ fontSize: 10, color: "#7a8a9a", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Composite</div>
                      </div>
                      {/* Breakdown */}
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={{ fontSize: 11, color: "#7a8a9a", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Breakdown</div>
                        {[
                          { label: "Insider Conviction", score: breakdown.insiderConvictionScore, max: 40 },
                          { label: "Fundamentals", score: breakdown.fundamentalsScore, max: 25 },
                          { label: "Valuation", score: breakdown.valuationScore, max: 20 },
                          { label: "Catalyst", score: breakdown.catalystScore, max: 15 },
                        ].map((b) => (
                          <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                            <span style={{ fontSize: 12, color: "#9aa4ad", width: 130, flexShrink: 0 }}>{b.label}</span>
                            <div style={{ flex: 1, background: "#1a2530", borderRadius: 4, height: 8, overflow: "hidden" }}>
                              <div style={{ width: `${(b.score / b.max) * 100}%`, height: "100%", background: b.score / b.max >= 0.7 ? "#6ecf8a" : b.score / b.max >= 0.4 ? "#ffd080" : "#4a6a8a", borderRadius: 4 }} />
                            </div>
                            <span style={{ fontSize: 12, color: "#c8d4e0", width: 40, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{b.score}/{b.max}</span>
                          </div>
                        ))}
                        {/* Short interest badge */}
                        {shortFloat != null && (
                          <div style={{ marginTop: 6 }}>
                            <span style={{
                              ...badge(shortFloat > 0.2 ? "#2d0d0d" : shortFloat > 0.05 ? "#2a2000" : "#0d2d1a"),
                              color: shortFloat > 0.2 ? "#ff8a8a" : shortFloat > 0.05 ? "#ffd080" : "#6ecf8a",
                              fontSize: 11,
                            }}>
                              Short: {(shortFloat * 100).toFixed(1)}% of float
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                    <p style={{ color: "#7a8a9a", fontSize: 12, margin: "8px 0 0", lineHeight: 1.6 }}>{rationale}</p>
                    <div style={{ color: "#4a5a6a", fontSize: 11, marginTop: 6, display: "flex", gap: 6 }}>
                      {cs && <span style={{ color: "#7cc4ff" }}>⚡ cached</span>}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
          {!compositeScore && !compositeLoading && !compositeError && (
            <div style={{ marginBottom: 14, display: "flex", justifyContent: "flex-start" }}>
              <button
                onClick={() => void fetchCompositeScore()}
                disabled={!isAuthenticated}
                title={isAuthenticated ? "Compute composite conviction score" : "Sign in to use AI features"}
                style={{ ...btn("#1a2a1a"), padding: "6px 14px", fontSize: 13, opacity: !isAuthenticated ? 0.5 : 1 }}
              >
                ✦ Compute Composite Score
              </button>
            </div>
          )}

          {/* ── Earnings Sentiment Card ── */}
          {(earningsSentiment || earningsSentimentPhase !== "idle" || earningsSentimentError) && (
            <div style={{ marginBottom: 14, padding: "14px 16px", background: "#090e14", borderRadius: 8, border: "1px solid #1e2832" }}>
              <div style={{ fontSize: 11, color: "#7a8a9a", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, marginBottom: 8 }}>
                Earnings Sentiment
                {earningsSentiment?.quarterCompared && (
                  <span style={{ fontWeight: 400, textTransform: "none", marginLeft: 8, color: "#4a5a6a" }}>
                    — {earningsSentiment.quarterCompared}
                  </span>
                )}
              </div>
              {earningsSentimentPhase === "ingesting" && (
                <p style={{ color: "#7a8a9a", fontSize: 13, margin: 0 }}>Ingesting filings…</p>
              )}
              {earningsSentimentPhase === "analyzing" && (
                <p style={{ color: "#7a8a9a", fontSize: 13, margin: 0 }}>Analyzing sentiment…</p>
              )}
              {earningsSentimentError && (
                <p style={{ color: "#ff8a8a", fontSize: 13, margin: 0 }}>{earningsSentimentError}</p>
              )}
              {earningsSentiment && earningsSentimentPhase === "idle" && (() => {
                const { sentimentDelta, keyThemeChanges, redFlags, confidenceSignals, modelUsed: mu, estimatedCost: ec, cached: sc } = earningsSentiment;
                const deltaBg: Record<string, string> = { improving: "#0d2d1a", deteriorating: "#2d0d0d", stable: "#1a2030", insufficient_data: "#1a1a2a" };
                const deltaColor: Record<string, string> = { improving: "#6ecf8a", deteriorating: "#ff8a8a", stable: "#9aa4ad", insufficient_data: "#7a8a9a" };
                const deltaIcon: Record<string, string> = { improving: "↑", deteriorating: "↓", stable: "→", insufficient_data: "?" };
                return (
                  <div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                      <span style={{ ...badge(deltaBg[sentimentDelta] ?? "#1a2030"), color: deltaColor[sentimentDelta] ?? "#9aa4ad", fontWeight: 700 }}>
                        {deltaIcon[sentimentDelta] ?? ""} {sentimentDelta.replace("_", " ")}
                      </span>
                      {sc && <span style={{ color: "#7cc4ff", fontSize: 11, marginLeft: "auto" }}>⚡ cached</span>}
                    </div>
                    {keyThemeChanges.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 11, color: "#7a8a9a", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Key Changes</div>
                        <ul style={{ margin: 0, paddingLeft: 16, color: "#9aa4ad", fontSize: 12, lineHeight: 1.7 }}>
                          {keyThemeChanges.map((c, i) => <li key={i}><span style={{ color: "#5a6a7a" }}>•</span> {c}</li>)}
                        </ul>
                      </div>
                    )}
                    {redFlags.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 11, color: "#7a8a9a", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Red Flags</div>
                        <ul style={{ margin: 0, paddingLeft: 16, color: "#ff8a8a", fontSize: 12, lineHeight: 1.7 }}>
                          {redFlags.map((f, i) => <li key={i}>⚠ {f}</li>)}
                        </ul>
                      </div>
                    )}
                    {confidenceSignals.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 11, color: "#7a8a9a", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Confidence Signals</div>
                        <ul style={{ margin: 0, paddingLeft: 16, color: "#6ecf8a", fontSize: 12, lineHeight: 1.7 }}>
                          {confidenceSignals.map((s, i) => <li key={i}>✓ {s}</li>)}
                        </ul>
                      </div>
                    )}
                    <div style={{ color: "#4a5a6a", fontSize: 11, display: "flex", gap: 6 }}>
                      <span>{mu}</span><span>·</span><span>${ec.toFixed(6)}</span>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
          {!earningsSentiment && earningsSentimentPhase === "idle" && !earningsSentimentError && (
            <div style={{ marginBottom: 14, display: "flex", justifyContent: "flex-start" }}>
              <button
                onClick={() => void fetchEarningsSentiment()}
                disabled={!isAuthenticated}
                title={isAuthenticated ? "Analyze earnings sentiment from MD&A" : "Sign in to use AI features"}
                style={{ ...btn("#1a2a3a"), padding: "6px 14px", fontSize: 13, opacity: !isAuthenticated ? 0.5 : 1 }}
              >
                ✦ Analyze Earnings Sentiment
              </button>
            </div>
          )}

          {/* ── Risk Flags Card ── */}
          {riskFlags && riskFlags.overallRiskLevel === "critical" && (
            <div style={{ marginBottom: 14, padding: "12px 16px", background: "#2d0d0d", borderRadius: 8, border: "1px solid #5a1a1a", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 16 }}>⚠</span>
              <span style={{ color: "#ff8a8a", fontWeight: 700, fontSize: 14 }}>Critical risk flags detected in {riskFlags.filingScanned}</span>
            </div>
          )}
          {riskFlags && riskFlags.overallRiskLevel === "high" && (
            <div style={{ marginBottom: 14, padding: "12px 16px", background: "#2a1a00", borderRadius: 8, border: "1px solid #5a4a1a", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 16 }}>⚠</span>
              <span style={{ color: "#ffd080", fontWeight: 700, fontSize: 14 }}>Elevated risk flags detected in {riskFlags.filingScanned}</span>
            </div>
          )}
          {(riskFlags || riskFlagsLoading || riskFlagsError) && (
            <div style={{ marginBottom: 14, padding: "14px 16px", background: "#090e14", borderRadius: 8, border: "1px solid #1e2832" }}>
              <div style={{ fontSize: 11, color: "#7a8a9a", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, marginBottom: 8 }}>
                Risk Flags
                {riskFlags?.filingScanned && (
                  <span style={{ fontWeight: 400, textTransform: "none", marginLeft: 8, color: "#4a5a6a" }}>
                    — scanned {riskFlags.filingScanned}
                  </span>
                )}
              </div>
              {riskFlagsLoading && <p style={{ color: "#7a8a9a", fontSize: 13, margin: 0 }}>Scanning filing…</p>}
              {riskFlagsError && <p style={{ color: "#ff8a8a", fontSize: 13, margin: 0 }}>{riskFlagsError}</p>}
              {riskFlags && !riskFlagsLoading && (() => {
                const { flags, overallRiskLevel, modelUsed: mu, estimatedCost: ec, cached: rc } = riskFlags;
                const severityBg: Record<string, string> = { high: "#2d0d0d", medium: "#2a1a00", low: "#1a2030" };
                const severityColor: Record<string, string> = { high: "#ff8a8a", medium: "#ffd080", low: "#9aa4ad" };
                return (
                  <div>
                    {flags.length === 0 ? (
                      <p style={{ color: "#6ecf8a", fontSize: 13, margin: "0 0 8px" }}>✓ No material risk flags detected</p>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                        {flags.map((f, i) => (
                          <span
                            key={i}
                            onClick={() => setExpandedRiskFlag((prev) => {
                              const next = new Set(prev);
                              if (next.has(i)) next.delete(i); else next.add(i);
                              return next;
                            })}
                            style={{ ...badge(severityBg[f.severity] ?? "#1a2030"), color: severityColor[f.severity] ?? "#9aa4ad", cursor: "pointer", fontSize: 12 }}
                            title="Click to expand"
                          >
                            {f.category}
                            {expandedRiskFlag.has(i) && (
                              <span style={{ display: "block", fontSize: 11, color: "#9aa4ad", fontWeight: 400, marginTop: 2, maxWidth: 260 }}>
                                {f.evidence}
                              </span>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                    <div style={{ color: "#4a5a6a", fontSize: 11, display: "flex", gap: 6, alignItems: "center" }}>
                      <span style={{ ...badge(overallRiskLevel === "critical" ? "#2d0d0d" : overallRiskLevel === "high" ? "#2a1a00" : overallRiskLevel === "medium" ? "#1a1a2a" : "#0d2d1a"), color: overallRiskLevel === "critical" || overallRiskLevel === "high" ? "#ff8a8a" : overallRiskLevel === "medium" ? "#9aa4ad" : "#6ecf8a", fontSize: 11 }}>
                        {overallRiskLevel}
                      </span>
                      <span>{mu}</span><span>·</span><span>${ec.toFixed(6)}</span>
                      {rc && <span style={{ color: "#7cc4ff" }}>⚡ cached</span>}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
          {!riskFlags && !riskFlagsLoading && !riskFlagsError && (
            <div style={{ marginBottom: 14, display: "flex", justifyContent: "flex-start" }}>
              <button
                onClick={() => void fetchRiskFlags()}
                disabled={!isAuthenticated}
                title={isAuthenticated ? "Scan most recent 10-K for risk flags" : "Sign in to use AI features"}
                style={{ ...btn("#2a1a1a"), padding: "6px 14px", fontSize: 13, opacity: !isAuthenticated ? 0.5 : 1 }}
              >
                ✦ Scan for Risk Flags
              </button>
            </div>
          )}

          {/* ── Tabs ── */}
          <div style={{ display: "flex", gap: 16, borderBottom: "1px solid #1e2832", marginBottom: 12 }}>
            <button
              onClick={() => setActiveTab("insiders")}
              style={{
                background: "none", border: "none", padding: "8px 0", cursor: "pointer",
                fontSize: 14, fontWeight: 600,
                color: activeTab === "insiders" ? "#e6e8eb" : "#7a8a9a",
                borderBottom: activeTab === "insiders" ? "2px solid #7cc4ff" : "2px solid transparent",
              }}
            >
              Insider Transactions
            </button>
            {eightKEventsCount > 0 && (
              <button
                onClick={() => setActiveTab("8k")}
                style={{
                  background: "none", border: "none", padding: "8px 0", cursor: "pointer",
                  fontSize: 14, fontWeight: 600,
                  color: activeTab === "8k" ? "#e6e8eb" : "#7a8a9a",
                  borderBottom: activeTab === "8k" ? "2px solid #7cc4ff" : "2px solid transparent",
                }}
              >
                8-K Events ({eightKEventsCount})
              </button>
            )}
            {thirteenFHoldingsCount > 0 && (
              <button
                onClick={() => setActiveTab("13f")}
                style={{
                  background: "none", border: "none", padding: "8px 0", cursor: "pointer",
                  fontSize: 14, fontWeight: 600,
                  color: activeTab === "13f" ? "#e6e8eb" : "#7a8a9a",
                  borderBottom: activeTab === "13f" ? "2px solid #7cc4ff" : "2px solid transparent",
                }}
              >
                13F Holdings ({thirteenFHoldingsCount})
              </button>
            )}
            {thirteenDGCount > 0 && (
              <button
                onClick={() => setActiveTab("13dg")}
                style={{
                  background: "none", border: "none", padding: "8px 0", cursor: "pointer",
                  fontSize: 14, fontWeight: 600,
                  color: activeTab === "13dg" ? "#e6e8eb" : "#7a8a9a",
                  borderBottom: activeTab === "13dg" ? "2px solid #c084fc" : "2px solid transparent",
                }}
              >
                Activist Activity ({thirteenDGCount})
              </button>
            )}
            {annualFilingsCount > 0 && (
              <button
                onClick={() => setActiveTab("annual")}
                style={{
                  background: "none", border: "none", padding: "8px 0", cursor: "pointer",
                  fontSize: 14, fontWeight: 600,
                  color: activeTab === "annual" ? "#e6e8eb" : "#7a8a9a",
                  borderBottom: activeTab === "annual" ? "2px solid #7cc4ff" : "2px solid transparent",
                }}
              >
                Annual Filings ({annualFilingsCount})
              </button>
            )}
          </div>

          {activeTab === "insiders" && (
            <>
              {/* Summarize All button */}
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                <button
                  onClick={() => void summarizeAll()}
                  disabled={companySummarizing || !isAuthenticated}
                  title={isAuthenticated ? "Summarize all filings" : "Sign in to use AI features"}
                  style={{
                    ...btn("#1a3a2a"),
                    padding: "5px 14px",
                    fontSize: 13,
                    fontWeight: 500,
                    opacity: companySummarizing || !isAuthenticated ? 0.65 : 1,
                  }}
                >
                  {companySummarizing ? "Summarizing…" : "✦ Summarize All"}
                </button>
              </div>

              {/* Company-level AI summary overview */}
              {companySummaryEntries.length > 0 && (
                <div
                  style={{
                    marginBottom: 12,
                    padding: "10px 12px",
                    background: "#0a1016",
                    borderRadius: 8,
                    border: "1px solid #1e2832",
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      color: "#7a8a9a",
                      marginBottom: 8,
                      fontWeight: 600,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                    }}
                  >
                    AI Summaries —{" "}
                    {companySummaryEntries.length} filing
                    {companySummaryEntries.length !== 1 ? "s" : ""}
                  </div>
                  {companySummaryEntries.map(({ url, summary }) => (
                    <div
                      key={url}
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "flex-start",
                        marginBottom: 6,
                        paddingBottom: 6,
                        borderBottom: "1px solid #141e28",
                      }}
                    >
                      <span
                        style={{
                          ...badge(impactBg[summary.impactRating] ?? "#1a2030"),
                          color: impactText[summary.impactRating] ?? "#9aa4ad",
                          fontWeight: 700,
                          flexShrink: 0,
                          fontSize: 11,
                        }}
                      >
                        {summary.impactRating}
                      </span>
                      <span style={{ color: "#9aa4ad", fontSize: 12, lineHeight: 1.5 }}>
                        {summary.summary.length > 150
                          ? summary.summary.slice(0, 150) + "…"
                          : summary.summary}
                      </span>
                      {summary.cached && (
                        <span
                          style={{
                            color: "#7cc4ff",
                            fontSize: 11,
                            flexShrink: 0,
                            marginLeft: "auto",
                          }}
                        >
                          ⚡
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {company.insiders.length === 0 && (
                <p style={{ color: "#7a8a9a", fontSize: 13, margin: "8px 0 0" }}>
                  No insiders recorded.
                </p>
              )}

              {company.insiders.map((insider) => (
                <div key={insider.cik} style={insiderBlock}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: 6,
                    }}
                  >
                    <div>
                      <strong>{insider.name}</strong>
                      {insider.title && (
                        <span style={{ color: "#7a8a9a", marginLeft: 8, fontSize: 13 }}>
                          {insider.title}
                        </span>
                      )}
                    </div>
                    <span style={badge("#1a2a3a")}>{insider.relationship}</span>
                  </div>

                  {insider.transactions.length > 0 && (
                    <div style={{ marginTop: 8, overflowX: "auto" }}>
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          fontSize: 13,
                        }}
                      >
                        <thead>
                          <tr
                            style={{
                              borderBottom: "1px solid #2a3a4a",
                              color: "#8ca2b8",
                              textAlign: "left",
                            }}
                          >
                            <th style={{ padding: "5px 8px" }}>Date</th>
                            <th style={{ padding: "5px 8px" }}>Form</th>
                            <th style={{ padding: "5px 8px" }}>Type</th>
                            <th style={{ padding: "5px 8px" }}>Code</th>
                            <th style={{ padding: "5px 8px", textAlign: "right" }}>Shares</th>
                            <th style={{ padding: "5px 8px", textAlign: "right" }}>Price</th>
                            <th style={{ padding: "5px 8px", textAlign: "right" }}>Total</th>
                            <th style={{ padding: "5px 8px", textAlign: "right" }}>Held After</th>
                            <th style={{ padding: "5px 8px" }}>Own</th>
                            <th style={{ padding: "5px 8px" }}>Filed</th>
                            <th style={{ padding: "5px 8px" }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {insider.transactions.map((t) => (
                            <Fragment key={t.id}>
                              <tr style={{ borderBottom: "1px solid #1a2530" }}>
                                <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>
                                  {t.transactionDate}
                                </td>
                                <td style={{ padding: "5px 8px" }}>
                                  <span style={badge("#1e2832")}>{t.filingType}</span>
                                </td>
                                <td style={{ padding: "5px 8px" }}>
                                  <span style={badge(txnColor[t.transactionType] ?? txnColor.other)}>
                                    {t.transactionType}
                                  </span>
                                </td>
                                <td style={{ padding: "5px 8px" }}>
                                  {t.transactionCode && (
                                    <span style={{ color: "#7a8a9a", fontSize: 12, fontFamily: "monospace" }}>
                                      {t.transactionCode}
                                    </span>
                                  )}
                                </td>
                                <td style={{ padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                  {Number(t.shares).toLocaleString()}
                                </td>
                                <td style={{ padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                  ${Number(t.pricePerShare).toFixed(2)}
                                </td>
                                <td style={{ padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                  ${Number(t.totalValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                                <td style={{ padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                  {Number(t.sharesOwnedAfter).toLocaleString()}
                                </td>
                                <td style={{ padding: "5px 8px", fontSize: 11 }}>
                                  <span style={{ color: t.isDirectOwnership ? "#6ecf8a" : "#ffd080" }}>
                                    {t.isDirectOwnership ? "D" : "I"}
                                  </span>
                                </td>
                                <td style={{ padding: "5px 8px", whiteSpace: "nowrap", fontSize: 11, color: "#7a8a9a" }}>
                                  {t.filedAt}
                                  {(() => {
                                    const txnDate = new Date(t.transactionDate).getTime();
                                    const fileDate = new Date(t.filedAt).getTime();
                                    if (Number.isNaN(txnDate) || Number.isNaN(fileDate)) return null;
                                    const lag = Math.round((fileDate - txnDate) / 86_400_000);
                                    if (lag > 2) return <span style={{ color: "#ffd080", marginLeft: 4 }}>+{lag}d</span>;
                                    return null;
                                  })()}
                                </td>
                                <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>
                                  <a
                                    href={t.filingUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ color: "#7cc4ff", fontSize: 11, marginRight: 6 }}
                                  >
                                    SEC↗
                                  </a>
                                  <button
                                    onClick={() => handleSummarize(t.id, t.filingUrl, t.filingType)}
                                    disabled={summaryLoading.has(t.filingUrl) || !isAuthenticated}
                                    title={isAuthenticated ? "AI summary" : "Sign in to use AI features"}
                                    style={{
                                      ...btn(
                                        expandedSummaries.has(t.id) && !deepUrls.has(t.filingUrl)
                                          ? "#1a3a5a"
                                          : "#1e2832",
                                      ),
                                      padding: "2px 8px",
                                      fontSize: 11,
                                      fontWeight: 500,
                                      marginRight: 4,
                                      opacity: summaryLoading.has(t.filingUrl) || !isAuthenticated ? 0.5 : 1,
                                    }}
                                  >
                                    {summaryLoading.has(t.filingUrl) && !summaries.has(t.filingUrl)
                                      ? "…"
                                      : expandedSummaries.has(t.id) && !deepUrls.has(t.filingUrl)
                                        ? "▴ AI"
                                        : summaries.has(t.filingUrl)
                                          ? "✦ AI"
                                          : "▾ AI"}
                                  </button>
                                  <button
                                    onClick={() => handleSummarize(t.id, t.filingUrl, t.filingType, true)}
                                    disabled={summaryLoading.has(t.filingUrl) || !isAuthenticated}
                                    title={isAuthenticated ? "Deep Analysis (Claude Sonnet)" : "Sign in to use AI features"}
                                    style={{
                                      ...btn(
                                        expandedSummaries.has(t.id) && deepUrls.has(t.filingUrl)
                                          ? "#1a3a1a"
                                          : "#1e2020",
                                      ),
                                      padding: "2px 6px",
                                      fontSize: 11,
                                      fontWeight: 500,
                                      opacity: summaryLoading.has(t.filingUrl) || !isAuthenticated ? 0.5 : 1,
                                    }}
                                  >
                                    🔬
                                  </button>
                                </td>
                              </tr>

                              {/* Inline summary panel row */}
                              {expandedSummaries.has(t.id) && (
                                <tr>
                                  <td colSpan={11} style={{ padding: 0, background: "#090e14" }}>
                                    {summaryLoading.has(t.filingUrl) && !summaries.has(t.filingUrl) && (
                                      <div style={{ padding: "10px 14px", color: "#7a8a9a", fontSize: 13, borderTop: "1px solid #1a2530" }}>
                                        Summarizing…
                                      </div>
                                    )}
                                    {summaryErrors.get(t.filingUrl) && !summaries.has(t.filingUrl) && (
                                      <div style={{ padding: "8px 14px", color: "#ff8a8a", fontSize: 12, borderTop: "1px solid #1a2530" }}>
                                        {summaryErrors.get(t.filingUrl)}
                                      </div>
                                    )}
                                    {summaries.has(t.filingUrl) && (
                                      <SummaryPanel
                                        summary={summaries.get(t.filingUrl)!}
                                        isDeep={deepUrls.has(t.filingUrl)}
                                        onDeepAnalysis={() => handleSummarize(t.id, t.filingUrl, t.filingType, true)}
                                      />
                                    )}
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {insider.transactions.length === 0 && (
                    <p style={{ color: "#7a8a9a", fontSize: 12, margin: "6px 0 0" }}>
                      Initial ownership declaration (no transactions).
                    </p>
                  )}
                </div>
              ))}
            </>
          )}

          {activeTab === "8k" && company.eightKEvents && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #2a3a4a", color: "#8ca2b8", textAlign: "left" }}>
                    <th style={{ padding: "8px" }}>Date</th>
                    <th style={{ padding: "8px" }}>Items</th>
                    <th style={{ padding: "8px" }}>Excerpt</th>
                    <th style={{ padding: "8px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {company.eightKEvents.map((e) => (
                    <tr key={e.accessionNo} style={{ borderBottom: "1px solid #1a2530" }}>
                      <td style={{ padding: "8px", whiteSpace: "nowrap", color: "#c8d4e0", verticalAlign: "top" }}>
                        {e.filingDate}
                      </td>
                      <td style={{ padding: "8px", verticalAlign: "top" }}>
                        {e.items.map((item, idx) => (
                          <span key={idx} style={{ ...badge("#1e2832"), marginRight: 4, marginBottom: 4 }}>
                            {item}
                          </span>
                        ))}
                      </td>
                      <td style={{ padding: "8px", color: "#9aa4ad", lineHeight: 1.5, maxWidth: 400 }}>
                        {e.textExcerpt.length > 200 ? (
                          <span
                            style={{ cursor: "pointer" }}
                            onClick={() =>
                              setExpanded8K((prev) => {
                                const next = new Set(prev);
                                if (next.has(e.accessionNo)) next.delete(e.accessionNo);
                                else next.add(e.accessionNo);
                                return next;
                              })
                            }
                          >
                            {expanded8K.has(e.accessionNo)
                              ? e.textExcerpt
                              : e.textExcerpt.slice(0, 200) + "… ▾"}
                          </span>
                        ) : (
                          e.textExcerpt
                        )}
                      </td>
                      <td style={{ padding: "8px", whiteSpace: "nowrap", verticalAlign: "top" }}>
                        {e.primaryDocUrl && (
                          <a
                            href={e.primaryDocUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "#7cc4ff", fontSize: 12 }}
                          >
                            SEC↗
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "13f" && company.thirteenFHoldings && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #2a3a4a", color: "#8ca2b8", textAlign: "left" }}>
                    <th style={{ padding: "8px" }}>Period</th>
                    <th style={{ padding: "8px" }}>Filer</th>
                    <th style={{ padding: "8px" }}>Company</th>
                    <th style={{ padding: "8px" }}>CUSIP</th>
                    <th style={{ padding: "8px", textAlign: "right" }}>Shares</th>
                    <th style={{ padding: "8px", textAlign: "right" }}>Value (USD)</th>
                    <th style={{ padding: "8px", textAlign: "center" }}>Discretion</th>
                    <th style={{ padding: "8px", textAlign: "center" }}>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {company.thirteenFHoldings.map((h) => (
                    <tr key={h.id} style={{ borderBottom: "1px solid #1a2530" }}>
                      <td style={{ padding: "8px", whiteSpace: "nowrap", color: "#9aa4ad" }}>
                        {h.periodOfReport}
                      </td>
                      <td style={{ padding: "8px", color: "#c8d4e0", maxWidth: 200 }}>
                        {h.filerName}
                      </td>
                      <td style={{ padding: "8px", color: "#c8d4e0" }}>
                        {h.companyName}
                      </td>
                      <td style={{ padding: "8px", color: "#7a8a9a", fontSize: 12 }}>
                        {h.cusip}
                      </td>
                      <td style={{ padding: "8px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#c8d4e0" }}>
                        {Number(h.shares).toLocaleString()}
                      </td>
                      <td style={{ padding: "8px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#c8d4e0" }}>
                        ${Number(h.valueUsd * 1000).toLocaleString()}
                      </td>
                      <td style={{ padding: "8px", textAlign: "center" }}>
                        {h.investmentDiscretion ? (
                          <span style={{ ...badge("#1e2832"), fontSize: 11 }}>{h.investmentDiscretion}</span>
                        ) : (
                          <span style={{ color: "#4a5a6a" }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: "8px", textAlign: "center" }}>
                        {h.putCall ? (
                          <span style={badge(h.putCall.toLowerCase() === "put" ? "#5a1a1a" : "#1a5a3a")}>
                            {h.putCall}
                          </span>
                        ) : (
                          <span style={{ color: "#4a5a6a" }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "13dg" && company.thirteenDGFilings && (
            <div>
              {/* Analyze button */}
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
                <button
                  onClick={() => void fetchActivistAnalysis()}
                  disabled={activistLoading || !isAuthenticated}
                  title={isAuthenticated ? "Analyze activist thesis with AI" : "Sign in to use AI features"}
                  style={{
                    ...btn(activistExpanded && activistAnalysis ? "#2a1a3a" : "#1a1a3a"),
                    padding: "6px 14px",
                    fontSize: 13,
                    opacity: activistLoading || !isAuthenticated ? 0.6 : 1,
                  }}
                >
                  {activistLoading ? "Analyzing…" : activistExpanded && activistAnalysis ? "▴ Activist Thesis" : "✦ Analyze Activist Thesis"}
                </button>
              </div>

              {activistError && (
                <p style={{ color: "#ff8a8a", fontSize: 13, margin: "0 0 10px" }}>{activistError}</p>
              )}

              {/* Activist Analysis Panel */}
              {activistExpanded && activistAnalysis && (() => {
                const thesisBg: Record<string, string> = {
                  "Strategic Sale / M&A": "#3a1a1a",
                  "Board Reconstitution": "#2a1a00",
                  "Business Separation / Spin-off": "#3a1a1a",
                  "Operational Improvement": "#2a2000",
                  "Management Change": "#2a2000",
                  "Balance Sheet Restructuring": "#2a2000",
                  "Capital Return / Buyback": "#0d2a2a",
                  "Undervaluation / Passive Accumulation": "#0d2a2a",
                };
                const thesisColor: Record<string, string> = {
                  "Strategic Sale / M&A": "#ff8a8a",
                  "Board Reconstitution": "#ffd080",
                  "Business Separation / Spin-off": "#ff8a8a",
                  "Operational Improvement": "#ffd080",
                  "Management Change": "#ffd080",
                  "Balance Sheet Restructuring": "#ffd080",
                  "Capital Return / Buyback": "#6ecfcf",
                  "Undervaluation / Passive Accumulation": "#6ecfcf",
                };
                const toneBg: Record<string, string> = {
                  cooperative: "#0d2d1a",
                  cautious: "#2a2000",
                  hostile: "#2d0d0d",
                };
                const toneColor: Record<string, string> = {
                  cooperative: "#6ecf8a",
                  cautious: "#ffd080",
                  hostile: "#ff8a8a",
                };
                const bg = thesisBg[activistAnalysis.thesisCategory] ?? "#1a1a2a";
                const color = thesisColor[activistAnalysis.thesisCategory] ?? "#c084fc";
                return (
                  <div style={{ marginBottom: 14, padding: "14px 16px", background: "#090e14", borderRadius: 8, border: "1px solid #2a1a3a" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                      <span style={{ ...badge(bg), color, fontWeight: 700, fontSize: 13 }}>
                        {activistAnalysis.thesisCategory}
                      </span>
                      <span style={{ ...badge(toneBg[activistAnalysis.tone] ?? "#1a2030"), color: toneColor[activistAnalysis.tone] ?? "#9aa4ad", fontSize: 12 }}>
                        {activistAnalysis.tone}
                      </span>
                      {activistAnalysis.filerCount > 1 && (
                        <span style={{ ...badge("#1a2030"), fontSize: 12 }}>
                          {activistAnalysis.filerCount} filers
                        </span>
                      )}
                      {activistAnalysis.totalPercentDisclosed != null && activistAnalysis.totalPercentDisclosed > 0 && (
                        <span style={{ ...badge("#1a3a1a"), color: "#6ecf8a", fontWeight: 700, fontSize: 12 }}>
                          {activistAnalysis.totalPercentDisclosed.toFixed(1)}% total disclosed
                        </span>
                      )}
                      {activistAnalysis.cached && (
                        <span style={{ color: "#7cc4ff", fontSize: 11, marginLeft: "auto" }}>⚡ cached</span>
                      )}
                    </div>

                    {activistAnalysis.specificDemands.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, color: "#7a8a9a", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
                          Specific Demands
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 18, color: "#c8d4e0", fontSize: 13, lineHeight: 1.7 }}>
                          {activistAnalysis.specificDemands.map((d, i) => (
                            <li key={i}>{d}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {activistAnalysis.timelineSignals.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, color: "#7a8a9a", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
                          Timeline Signals
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 18, color: "#c8d4e0", fontSize: 13, lineHeight: 1.7 }}>
                          {activistAnalysis.timelineSignals.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {activistAnalysis.catalystRisk && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, color: "#7a8a9a", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
                          Catalyst Risk
                        </div>
                        <p style={{ margin: 0, color: "#ff8a8a", fontSize: 13, lineHeight: 1.6 }}>
                          {activistAnalysis.catalystRisk}
                        </p>
                      </div>
                    )}

                    {activistAnalysis.convergenceNote && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, color: "#7a8a9a", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
                          Convergence
                        </div>
                        <p style={{ margin: 0, color: "#9aa4ad", fontSize: 13, lineHeight: 1.6 }}>
                          {activistAnalysis.convergenceNote}
                        </p>
                      </div>
                    )}

                    <div style={{ color: "#4a5a6a", fontSize: 11, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span>{activistAnalysis.modelUsed}</span>
                      <span>·</span>
                      <span>${activistAnalysis.estimatedCost.toFixed(6)}</span>
                    </div>
                  </div>
                );
              })()}

              {/* Filings table */}
              {company.thirteenDGFilings.length === 0 && (
                <p style={{ color: "#7a8a9a", fontSize: 13, margin: "8px 0 0" }}>
                  No activist filings recorded.
                </p>
              )}
              {company.thirteenDGFilings.length > 0 && (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #2a3a4a", color: "#8ca2b8", textAlign: "left" }}>
                        <th style={{ padding: "8px" }}>Filer</th>
                        <th style={{ padding: "8px", textAlign: "right" }}>% of Class</th>
                        <th style={{ padding: "8px" }}>Filing Date</th>
                        <th style={{ padding: "8px" }}>Amendment</th>
                        <th style={{ padding: "8px" }}>Item 4</th>
                        <th style={{ padding: "8px" }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {company.thirteenDGFilings.map((f) => (
                        <Fragment key={f.id}>
                          <tr style={{ borderBottom: "1px solid #1a2530" }}>
                            <td style={{ padding: "8px", color: "#c8d4e0", maxWidth: 180 }}>
                              {f.filerName}
                            </td>
                            <td style={{ padding: "8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                              {f.percentOfClass != null ? (
                                <span style={{ ...badge("#1a3a1a"), color: "#6ecf8a", fontWeight: 700 }}>
                                  {f.percentOfClass}%
                                </span>
                              ) : (
                                <span style={{ color: "#4a5a6a" }}>—</span>
                              )}
                            </td>
                            <td style={{ padding: "8px", color: "#9aa4ad", whiteSpace: "nowrap" }}>
                              {f.filingDate}
                            </td>
                            <td style={{ padding: "8px" }}>
                              {f.amendmentType ? (
                                <span style={badge("#2a1a1a")}>{f.amendmentType}</span>
                              ) : (
                                <span style={{ color: "#4a5a6a" }}>—</span>
                              )}
                            </td>
                            <td style={{ padding: "8px", color: "#9aa4ad", maxWidth: 260 }}>
                              {f.item4Excerpt ? (
                                <span
                                  style={{ cursor: "pointer" }}
                                  onClick={() =>
                                    setExpandedItem4((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(f.id)) next.delete(f.id);
                                      else next.add(f.id);
                                      return next;
                                    })
                                  }
                                >
                                  {expandedItem4.has(f.id)
                                    ? f.item4Excerpt
                                    : f.item4Excerpt.length > 120
                                      ? f.item4Excerpt.slice(0, 120) + "… ▾"
                                      : f.item4Excerpt}
                                </span>
                              ) : (
                                <span style={{ color: "#4a5a6a" }}>—</span>
                              )}
                            </td>
                            <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                              {f.primaryDocUrl && (
                                <a
                                  href={f.primaryDocUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ color: "#7cc4ff", fontSize: 12 }}
                                >
                                  SEC↗
                                </a>
                              )}
                            </td>
                          </tr>
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeTab === "annual" && company.annualFilings && (
            <div>
              {company.annualFilings.length === 0 && (
                <p style={{ color: "#7a8a9a", fontSize: 13, margin: "8px 0 0" }}>
                  No annual filings recorded. Run an ingest to fetch 10-Q/10-K data.
                </p>
              )}
              {company.annualFilings.length > 0 && (
                <div>
                  {company.annualFilings.map((af) => (
                    <div
                      key={af.id}
                      style={{
                        marginBottom: 12, padding: "12px 14px", background: "#0c1218",
                        borderRadius: 8, border: "1px solid #1a2530",
                      }}
                    >
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                        <span style={{
                          ...badge(af.formType === "10-K" ? "#1a3a2a" : "#1a2a3a"),
                          fontWeight: 700, fontSize: 12,
                        }}>
                          {af.formType}
                        </span>
                        <span style={{ color: "#9aa4ad", fontSize: 13 }}>
                          Filed {af.filingDate}
                        </span>
                        {af.periodOfReport && (
                          <span style={{ color: "#7a8a9a", fontSize: 12 }}>
                            Period: {af.periodOfReport}
                          </span>
                        )}
                        {af.primaryDocUrl && (
                          <a
                            href={af.primaryDocUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "#7cc4ff", fontSize: 12, marginLeft: "auto" }}
                          >
                            SEC↗
                          </a>
                        )}
                      </div>
                      {af.mdaExcerpt ? (
                        <div style={{ color: "#9aa4ad", fontSize: 12, lineHeight: 1.7 }}>
                          <div style={{
                            fontSize: 10, color: "#7a8a9a", textTransform: "uppercase",
                            letterSpacing: "0.06em", fontWeight: 600, marginBottom: 4,
                          }}>
                            MD&A Excerpt
                          </div>
                          {af.mdaExcerpt}
                        </div>
                      ) : (
                        <p style={{ color: "#4a5a6a", fontSize: 12, margin: 0 }}>
                          No MD&A excerpt available.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Loading state */}
      {loading && (
        <section style={{ ...panel, marginTop: 24, textAlign: "center" }}>
          <p style={{ color: "#7a8a9a", margin: 0 }}>Loading company data…</p>
        </section>
      )}
    </main>
  );
}
