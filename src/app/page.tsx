"use client";

import { Fragment, Suspense, useEffect, useState, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
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
  periodOfReport: string;
  filingDate: string;
  cusip: string;
  companyName: string;
  valueUsd: number;
  shares: number;
  putCall: string | null;
};

type Company = {
  cik: string;
  name: string;
  ticker: string | null;
  latestTransactionDate: string | null;
  insiders: Insider[];
  eightKEvents?: EightKEvent[];
  thirteenFHoldings?: ThirteenFHolding[];
};

type JobStep = {
  label: string;
  status: "pending" | "active" | "done" | "error";
  detail?: string;
  progress?: { current: number; total: number };
};

type IngestJob = {
  id: string;
  status: "running" | "completed" | "failed" | "idle";
  steps?: JobStep[];
  currentStep?: number;
  error?: string;
  result?: Record<string, unknown>;
  startedAt?: number;
  updatedAt?: number;
};

// ── Styles ─────────────────────────────────────────────────────────

const panel: React.CSSProperties = {
  border: "1px solid #1e2832",
  borderRadius: 12,
  padding: 20,
  background: "#0e151d",
};

const companyCard: React.CSSProperties = {
  marginTop: 14,
  border: "1px solid #1e2832",
  borderRadius: 10,
  padding: 16,
  background: "#101820",
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

    // Blank line → skip
    if (line.trim() === "") { i++; continue; }

    // Headings
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

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      elements.push(<hr key={key++} style={{ border: "none", borderTop: "1px solid #1e2832", margin: "10px 0" }} />);
      i++;
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) {
        items.push(<li key={items.length}>{inlineMarkdown(lines[i].replace(/^\s*[-*+]\s/, ""))}</li>);
        i++;
      }
      elements.push(<ul key={key++} style={{ margin: "6px 0", paddingLeft: 20, lineHeight: 1.7 }}>{items}</ul>);
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) {
        items.push(<li key={items.length}>{inlineMarkdown(lines[i].replace(/^\s*\d+[.)]\s/, ""))}</li>);
        i++;
      }
      elements.push(<ol key={key++} style={{ margin: "6px 0", paddingLeft: 20, lineHeight: 1.7 }}>{items}</ol>);
      continue;
    }

    // Paragraph: collect consecutive non-special lines
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

/** Parse inline markdown: **bold**, *italic*, `code`, [links](url) */
function inlineMarkdown(text: string): React.ReactNode {
  // Split on inline patterns, preserving delimiters
  const parts: React.ReactNode[] = [];
  // Process with a regex that captures bold, italic, inline code, and links
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let k = 0;

  while ((match = regex.exec(text)) !== null) {
    // Text before the match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[2]) {
      // **bold**
      parts.push(<strong key={k++} style={{ color: "#e6e8eb", fontWeight: 600 }}>{match[2]}</strong>);
    } else if (match[3]) {
      // *italic*
      parts.push(<em key={k++}>{match[3]}</em>);
    } else if (match[4]) {
      // `code`
      parts.push(
        <code key={k++} style={{ background: "#1a2530", padding: "1px 5px", borderRadius: 3, fontSize: "0.9em", color: "#7cc4ff" }}>
          {match[4]}
        </code>
      );
    } else if (match[5] && match[6]) {
      // [text](url)
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
      {/* Header: impact badge, issuer info, deep toggle */}
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

      {/* Summary text */}
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

      {/* Flags */}
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

      {/* Parsed transactions sub-table */}
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

      {/* Footer: model · cost · cache */}
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

// ── Progress Bar ───────────────────────────────────────────────────

function ProgressBar({ job }: { job: IngestJob }) {
  const steps = job.steps ?? [];
  const currentIdx = job.currentStep ?? -1;
  const activeStep = currentIdx >= 0 ? steps[currentIdx] : undefined;

  const doneSteps = steps.filter((s) => s.status === "done").length;
  const stepFraction =
    activeStep?.progress && activeStep.progress.total > 0
      ? activeStep.progress.current / activeStep.progress.total
      : 0;
  const overallPct =
    steps.length > 0
      ? Math.round(((doneSteps + stepFraction) / steps.length) * 100)
      : 0;

  const elapsed = job.startedAt ? Math.floor((Date.now() - job.startedAt) / 1000) : 0;
  const stale = job.updatedAt ? (Date.now() - job.updatedAt) / 1000 : 0;
  const isHung = job.status === "running" && stale > 90;

  const barColor =
    job.status === "failed"
      ? "#d44"
      : job.status === "completed"
        ? "#4a4"
        : isHung
          ? "#d4a017"
          : "#1a6dd4";

  const formatElapsed = (s: number) => {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        {steps.map((step, i) => {
          const colors: Record<string, string> = {
            done: "#4a4",
            active: "#1a6dd4",
            error: "#d44",
            pending: "#333",
          };
          const icons: Record<string, string> = {
            done: "✓",
            active: "●",
            error: "✗",
            pending: "○",
          };
          return (
            <span
              key={i}
              style={{
                fontSize: 12,
                color: step.status === "active" ? "#fff" : "#9aa4ad",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span style={{ color: colors[step.status], fontSize: 10 }}>
                {icons[step.status]}
              </span>
              {step.label}
              {i < steps.length - 1 && (
                <span style={{ color: "#333", marginLeft: 2 }}>→</span>
              )}
            </span>
          );
        })}
      </div>

      <div
        style={{
          height: 8,
          borderRadius: 4,
          background: "#1e2832",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${job.status === "completed" ? 100 : overallPct}%`,
            background: barColor,
            borderRadius: 4,
            transition: "width 0.3s ease",
          }}
        />
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 6,
          fontSize: 12,
          color: "#7a8a9a",
        }}
      >
        <span>
          {activeStep ? (
            <>
              Step {currentIdx + 1}/{steps.length}: {activeStep.label}
              {activeStep.progress && activeStep.progress.total > 0 && (
                <span style={{ color: "#9aa4ad", marginLeft: 6 }}>
                  ({activeStep.progress.current}/{activeStep.progress.total})
                </span>
              )}
              {activeStep.detail &&
                activeStep.status !== "error" &&
                !activeStep.progress && (
                  <span style={{ color: "#9aa4ad", marginLeft: 6 }}>
                    — {activeStep.detail}
                  </span>
                )}
            </>
          ) : job.status === "completed" ? (
            <span style={{ color: "#6ecf8a" }}>Complete</span>
          ) : (
            "Starting…"
          )}
        </span>
        <span>
          {isHung && (
            <span style={{ color: "#d4a017", marginRight: 8 }}>
              ⚠ No update for {Math.floor(stale)}s
            </span>
          )}
          {elapsed > 0 && formatElapsed(elapsed)}
        </span>
      </div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────

export default function Home() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const searchParams = useSearchParams();
  const [routeError, setRouteError] = useState("");

  // Show error from redirect (e.g. company not found)
  useEffect(() => {
    const err = searchParams.get("error");
    if (err) {
      setRouteError(err);
      // Clean the URL without reloading
      window.history.replaceState({}, "", "/");
    }
  }, [searchParams]);

  const [hours, setHours] = useState(72);
  const [job, setJob] = useState<IngestJob | null>(null);
  const [ingestResult, setIngestResult] = useState<string | null>(null);
  const [ingestError, setIngestError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Active tab per company: "insiders" | "8k" | "13f"
  const [activeTab, setActiveTab] = useState<Map<string, string>>(new Map());

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
  // Keyed by transaction ID so each row independently shows/hides its panel
  const [expandedSummaries, setExpandedSummaries] = useState<Set<number>>(new Set());
  // URLs fetched with deep_analysis=true
  const [deepUrls, setDeepUrls] = useState<Set<string>>(new Set());
  // Company CIKs with a batch summarize in flight
  const [companySummarizing, setCompanySummarizing] = useState<Set<string>>(new Set());

  const ingesting = job?.status === "running";

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/filings/ingest?jobId=${jobId}`);
          const data: IngestJob = await res.json();
          setJob(data);

          if (data.status === "completed") {
            stopPolling();
            const r = data.result;
            const parts: string[] = [];
            if (r?.transactions) parts.push(`${r.transactions} insider txns`);
            if (r?.eightKEvents) parts.push(`${r.eightKEvents} 8-K events`);
            if (r?.thirteenFHoldings) parts.push(`${r.thirteenFHoldings} 13F holdings`);
            const failTotal =
              ((r?.ownershipFailed as number) ?? 0) +
              ((r?.eightKFailed as number) ?? 0) +
              ((r?.thirteenFFailed as number) ?? 0);
            setIngestResult(
              `Ingested ${parts.join(", ")} across ${r?.companies ?? 0} companies` +
                (failTotal ? ` (${failTotal} failed to parse)` : ""),
            );
            loadCompanies();
            setTimeout(() => setJob(null), 4000);
          } else if (data.status === "failed") {
            stopPolling();
            setIngestError(data.error || "Ingest failed");
            setTimeout(() => setJob(null), 6000);
          }
        } catch {
          // network blip — keep polling
        }
      }, 1000);
    },
    [stopPolling],
  );

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/filings/ingest");
        const data: IngestJob = await res.json();
        if (data.status === "running" && data.id) {
          setJob(data);
          startPolling(data.id);
        }
      } catch {
        // ignore
      }
    })();
    loadCompanies();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  async function ingestFilings() {
    setIngestError("");
    setIngestResult(null);
    try {
      const res = await fetch(`/api/filings/ingest?hours=${hours}`, {
        method: "POST",
      });
      const data = await res.json();
      if (!data.jobId) throw new Error(data.error ?? "Failed to start ingest");
      setJob({ id: data.jobId, status: "running" });
      startPolling(data.jobId);
    } catch (e) {
      setIngestError(e instanceof Error ? e.message : "Unknown error");
    }
  }

  async function cancelIngest() {
    try {
      const res = await fetch("/api/filings/ingest", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cancel failed");
      stopPolling();
      setJob(null);
      setIngestError("Ingestion cancelled");
    } catch (e) {
      setIngestError(e instanceof Error ? e.message : "Unknown error");
    }
  }

  async function loadCompanies() {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch("/api/companies?limit=100");
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Failed to load");
      setCompanies(data.companies ?? []);

      // Pre-populate cached summaries from the API response
      if (data.summaries && typeof data.summaries === "object") {
        const cached = data.summaries as Record<string, FilingSummary>;
        const cachedUrls = new Set(Object.keys(cached));
        console.log(`[loadCompanies] pre-populating ${cachedUrls.size} cached summaries`);

        setSummaries((prev) => {
          const next = new Map(prev);
          for (const [url, summary] of Object.entries(cached)) {
            // Don't overwrite a deep analysis summary with a standard one
            if (!next.has(url)) {
              next.set(url, summary);
            }
          }
          return next;
        });

        // Auto-expand transaction rows that have cached summaries
        const companies: Company[] = data.companies ?? [];
        const autoExpand = new Set<number>();
        for (const co of companies) {
          for (const ins of co.insiders) {
            for (const t of ins.transactions) {
              if (cachedUrls.has(t.filingUrl)) {
                autoExpand.add(t.id);
              }
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
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  function toggleCompany(cik: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cik)) next.delete(cik);
      else {
        next.add(cik);
        setActiveTab((prevTabs) => {
          if (!prevTabs.has(cik)) {
            const nextTabs = new Map(prevTabs);
            nextTabs.set(cik, "insiders");
            return nextTabs;
          }
          return prevTabs;
        });
      }
      return next;
    });
  }

  function setCompanyTab(cik: string, tab: string) {
    setActiveTab((prev) => {
      const next = new Map(prev);
      next.set(cik, tab);
      return next;
    });
  }

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

    // Toggle closed: same button, panel open, summary loaded, not re-fetching
    if (isOpen && hasLoaded && currentIsDeep === deep && !isLoading) {
      setExpandedSummaries((prev) => {
        const next = new Set(prev);
        next.delete(txnId);
        return next;
      });
      return;
    }

    // Open the panel (show loading/summary inline)
    setExpandedSummaries((prev) => {
      const next = new Set(prev);
      next.add(txnId);
      return next;
    });

    // Fetch only if not already loaded at this depth and not already in flight
    if ((!hasLoaded || currentIsDeep !== deep) && !isLoading) {
      void fetchSummary(filingUrl, filingType, deep);
    }
  }

  async function summarizeCompany(company: Company) {
    setCompanySummarizing((prev) => {
      const next = new Set(prev);
      next.add(company.cik);
      return next;
    });

    // Collect the most-recent filing URL per insider, deduplicated
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

    setCompanySummarizing((prev) => {
      const next = new Set(prev);
      next.delete(company.cik);
      return next;
    });
  }

  const totalInsiders = companies.reduce((n, c) => n + c.insiders.length, 0);
  const totalTxns = companies.reduce(
    (n, c) => n + c.insiders.reduce((m, i) => m + i.transactions.length, 0),
    0,
  );

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "40px 20px 80px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 28, margin: 0 }}>Investment Seeker</h1>
          <p style={{ color: "#9aa4ad", marginTop: 4 }}>
            Track insider transactions by company. See who&rsquo;s buying and selling.
          </p>
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

      {/* Route-level error (e.g. company not found redirect) */}
      {routeError && (
        <div
          style={{
            marginTop: 16,
            padding: "12px 16px",
            background: "#2d0d0d",
            border: "1px solid #5a1a1a",
            borderRadius: 8,
            color: "#ff8a8a",
            fontSize: 14,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>{routeError}</span>
          <button
            onClick={() => setRouteError("")}
            style={{
              background: "none",
              border: "none",
              color: "#ff8a8a",
              cursor: "pointer",
              fontSize: 16,
              padding: "0 4px",
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Ingest Panel ── */}
      <section style={{ ...panel, marginTop: 24 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Ingest Filings</h2>
        <p style={{ color: "#7a8a9a", fontSize: 13, marginTop: 4 }}>
          Pull insider ownership (Forms 3, 4, 5), 8-K events, and 13F-HR holdings from SEC EDGAR.
        </p>
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "flex-end",
            flexWrap: "wrap",
            marginTop: 12,
          }}
        >
          <label>
            <div style={{ fontSize: 12, color: "#a9bfd5", marginBottom: 4 }}>Time window</div>
            <select
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              style={{ padding: "8px 10px", borderRadius: 6 }}
            >
              <option value={1}>1 hour</option>
              <option value={6}>6 hours</option>
              <option value={12}>12 hours</option>
              <option value={24}>24 hours</option>
              <option value={48}>2 days</option>
              <option value={72}>3 days</option>
              <option value={168}>7 days</option>
            </select>
          </label>
          <button onClick={ingestFilings} disabled={ingesting} style={btn("#1a6dd4")}>
            {ingesting ? "Ingesting…" : "Ingest Filings"}
          </button>
          {ingesting && (
            <button onClick={cancelIngest} style={btn("#5a1a1a")}>
              Kill Job
            </button>
          )}
          <button onClick={loadCompanies} disabled={loading} style={btn("#2e3a4a")}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {job && job.steps && <ProgressBar job={job} />}

        {ingestResult && (
          <p style={{ color: "#6ecf8a", marginTop: 10, fontSize: 14 }}>{ingestResult}</p>
        )}
        {ingestError && <p style={{ color: "#ff8a8a", marginTop: 10 }}>{ingestError}</p>}
      </section>

      {/* ── Companies Panel ── */}
      <section style={{ ...panel, marginTop: 20 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 20 }}>Companies</h2>
            {companies.length > 0 && (
              <span style={{ color: "#7a8a9a", fontSize: 13 }}>
                {companies.length} companies · {totalInsiders} insiders · {totalTxns} transactions
              </span>
            )}
          </div>
        </div>

        {loadError && <p style={{ color: "#ff8a8a", marginTop: 10 }}>{loadError}</p>}

        {companies.length === 0 && !loadError && !loading && (
          <p style={{ color: "#7a8a9a", marginTop: 16, fontSize: 14 }}>
            No data yet. Ingest filings to populate.
          </p>
        )}

        {companies.map((company) => {
          const isOpen = expanded.has(company.cik);
          const txnCount = company.insiders.reduce(
            (n, i) => n + i.transactions.length,
            0,
          );
          const isBatchRunning = companySummarizing.has(company.cik);
          const currentTab = activeTab.get(company.cik) ?? "insiders";
          const eightKEventsCount = company.eightKEvents?.length ?? 0;
          const thirteenFHoldingsCount = company.thirteenFHoldings?.length ?? 0;

          // Collect unique loaded summaries for this company (for the overview block)
          const companySummaryEntries = (() => {
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
            <div key={company.cik} style={companyCard}>
              {/* Company header — clickable to expand */}
              <div
                onClick={() => toggleCompany(company.cik)}
                style={{
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <div>
                  <strong style={{ fontSize: 16 }}>{company.name}</strong>
                  {company.ticker && (
                    <Link
                      href={`/company/${encodeURIComponent(company.ticker)}`}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        color: "#7cc4ff",
                        marginLeft: 10,
                        fontWeight: 600,
                        textDecoration: "none",
                        borderBottom: "1px dashed #7cc4ff40",
                      }}
                    >
                      {company.ticker}
                    </Link>
                  )}
                  {company.latestTransactionDate && (
                    <span style={{ color: "#7a8a9a", marginLeft: 10, fontSize: 13 }}>
                      Latest: {company.latestTransactionDate}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={badge("#1e2832")}>
                    {company.insiders.length} insider
                    {company.insiders.length !== 1 ? "s" : ""}
                  </span>
                  <span style={badge("#1e2832")}>
                    {txnCount} txn{txnCount !== 1 ? "s" : ""}
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
                  <span style={{ color: "#7a8a9a", fontSize: 18 }}>
                    {isOpen ? "▾" : "▸"}
                  </span>
                </div>
              </div>

              {/* Expanded content */}
              {isOpen && (
                <div style={{ marginTop: 16 }}>
                  {/* ── Tabs ── */}
                  <div style={{ display: "flex", gap: 16, borderBottom: "1px solid #1e2832", marginBottom: 12 }}>
                    <button
                      onClick={() => setCompanyTab(company.cik, "insiders")}
                      style={{
                        background: "none", border: "none", padding: "8px 0", cursor: "pointer",
                        fontSize: 14, fontWeight: 600,
                        color: currentTab === "insiders" ? "#e6e8eb" : "#7a8a9a",
                        borderBottom: currentTab === "insiders" ? "2px solid #7cc4ff" : "2px solid transparent",
                      }}
                    >
                      Insider Transactions
                    </button>
                    {(eightKEventsCount > 0) && (
                      <button
                        onClick={() => setCompanyTab(company.cik, "8k")}
                        style={{
                          background: "none", border: "none", padding: "8px 0", cursor: "pointer",
                          fontSize: 14, fontWeight: 600,
                          color: currentTab === "8k" ? "#e6e8eb" : "#7a8a9a",
                          borderBottom: currentTab === "8k" ? "2px solid #7cc4ff" : "2px solid transparent",
                        }}
                      >
                        8-K Events ({eightKEventsCount})
                      </button>
                    )}
                    {(thirteenFHoldingsCount > 0) && (
                      <button
                        onClick={() => setCompanyTab(company.cik, "13f")}
                        style={{
                          background: "none", border: "none", padding: "8px 0", cursor: "pointer",
                          fontSize: 14, fontWeight: 600,
                          color: currentTab === "13f" ? "#e6e8eb" : "#7a8a9a",
                          borderBottom: currentTab === "13f" ? "2px solid #7cc4ff" : "2px solid transparent",
                        }}
                      >
                        13F Holdings ({thirteenFHoldingsCount})
                      </button>
                    )}
                  </div>

                  {currentTab === "insiders" && (
                  <>
                  {/* ── Summarize All button ── */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      marginBottom: 8,
                    }}
                  >
                    <button
                      onClick={() => void summarizeCompany(company)}
                      disabled={isBatchRunning || !isAuthenticated}
                      title={isAuthenticated ? "Summarize all filings" : "Sign in to use AI features"}
                      style={{
                        ...btn("#1a3a2a"),
                        padding: "5px 14px",
                        fontSize: 13,
                        fontWeight: 500,
                        opacity: isBatchRunning || !isAuthenticated ? 0.65 : 1,
                      }}
                    >
                      {isBatchRunning ? "Summarizing…" : "✦ Summarize All"}
                    </button>
                  </div>

                  {/* ── Company-level AI summary overview ── */}
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
                          <span
                            style={{ color: "#9aa4ad", fontSize: 12, lineHeight: 1.5 }}
                          >
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
                                <th style={{ padding: "5px 8px", textAlign: "right" }}>
                                  Shares
                                </th>
                                <th style={{ padding: "5px 8px", textAlign: "right" }}>
                                  Price
                                </th>
                                <th style={{ padding: "5px 8px", textAlign: "right" }}>
                                  Total
                                </th>
                                <th style={{ padding: "5px 8px", textAlign: "right" }}>
                                  Held After
                                </th>
                                <th style={{ padding: "5px 8px" }}></th>
                              </tr>
                            </thead>
                            <tbody>
                              {insider.transactions.map((t) => (
                                <Fragment key={t.id}>
                                  <tr style={{ borderBottom: "1px solid #1a2530" }}>
                                    <td
                                      style={{
                                        padding: "5px 8px",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {t.transactionDate}
                                    </td>
                                    <td style={{ padding: "5px 8px" }}>
                                      <span style={badge("#1e2832")}>{t.filingType}</span>
                                    </td>
                                    <td style={{ padding: "5px 8px" }}>
                                      <span
                                        style={badge(
                                          txnColor[t.transactionType] ?? txnColor.other,
                                        )}
                                      >
                                        {t.transactionType}
                                      </span>
                                    </td>
                                    <td
                                      style={{
                                        padding: "5px 8px",
                                        textAlign: "right",
                                        fontVariantNumeric: "tabular-nums",
                                      }}
                                    >
                                      {Number(t.shares).toLocaleString()}
                                    </td>
                                    <td
                                      style={{
                                        padding: "5px 8px",
                                        textAlign: "right",
                                        fontVariantNumeric: "tabular-nums",
                                      }}
                                    >
                                      ${Number(t.pricePerShare).toFixed(2)}
                                    </td>
                                    <td
                                      style={{
                                        padding: "5px 8px",
                                        textAlign: "right",
                                        fontVariantNumeric: "tabular-nums",
                                      }}
                                    >
                                      $
                                      {Number(t.totalValue).toLocaleString(undefined, {
                                        minimumFractionDigits: 2,
                                        maximumFractionDigits: 2,
                                      })}
                                    </td>
                                    <td
                                      style={{
                                        padding: "5px 8px",
                                        textAlign: "right",
                                        fontVariantNumeric: "tabular-nums",
                                      }}
                                    >
                                      {Number(t.sharesOwnedAfter).toLocaleString()}
                                    </td>
                                    <td
                                      style={{
                                        padding: "5px 8px",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      <a
                                        href={t.filingUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{
                                          color: "#7cc4ff",
                                          fontSize: 11,
                                          marginRight: 6,
                                        }}
                                      >
                                        SEC↗
                                      </a>
                                      {/* AI Summarize button */}
                                      <button
                                        onClick={() =>
                                          handleSummarize(
                                            t.id,
                                            t.filingUrl,
                                            t.filingType,
                                          )
                                        }
                                        disabled={summaryLoading.has(t.filingUrl) || !isAuthenticated}
                                        title={isAuthenticated ? "AI summary" : "Sign in to use AI features"}
                                        style={{
                                          ...btn(
                                            expandedSummaries.has(t.id) &&
                                              !deepUrls.has(t.filingUrl)
                                              ? "#1a3a5a"
                                              : "#1e2832",
                                          ),
                                          padding: "2px 8px",
                                          fontSize: 11,
                                          fontWeight: 500,
                                          marginRight: 4,
                                          opacity: summaryLoading.has(t.filingUrl) || !isAuthenticated
                                            ? 0.5
                                            : 1,
                                        }}
                                      >
                                        {summaryLoading.has(t.filingUrl) &&
                                        !summaries.has(t.filingUrl)
                                          ? "…"
                                          : expandedSummaries.has(t.id) &&
                                              !deepUrls.has(t.filingUrl)
                                            ? "▴ AI"
                                            : summaries.has(t.filingUrl)
                                              ? "✦ AI"
                                              : "▾ AI"}
                                      </button>
                                      {/* Deep analysis button */}
                                      <button
                                        onClick={() =>
                                          handleSummarize(
                                            t.id,
                                            t.filingUrl,
                                            t.filingType,
                                            true,
                                          )
                                        }
                                        disabled={summaryLoading.has(t.filingUrl) || !isAuthenticated}
                                        title={isAuthenticated ? "Deep Analysis (Claude Sonnet)" : "Sign in to use AI features"}
                                        style={{
                                          ...btn(
                                            expandedSummaries.has(t.id) &&
                                              deepUrls.has(t.filingUrl)
                                              ? "#1a3a1a"
                                              : "#1e2020",
                                          ),
                                          padding: "2px 6px",
                                          fontSize: 11,
                                          fontWeight: 500,
                                          opacity: summaryLoading.has(t.filingUrl) || !isAuthenticated
                                            ? 0.5
                                            : 1,
                                        }}
                                      >
                                        🔬
                                      </button>
                                    </td>
                                  </tr>

                                  {/* Inline summary panel row */}
                                  {expandedSummaries.has(t.id) && (
                                    <tr>
                                      <td
                                        colSpan={8}
                                        style={{ padding: 0, background: "#090e14" }}
                                      >
                                        {/* Loading state (no summary yet) */}
                                        {summaryLoading.has(t.filingUrl) &&
                                          !summaries.has(t.filingUrl) && (
                                            <div
                                              style={{
                                                padding: "10px 14px",
                                                color: "#7a8a9a",
                                                fontSize: 13,
                                                borderTop: "1px solid #1a2530",
                                              }}
                                            >
                                              Summarizing…
                                            </div>
                                          )}
                                        {/* Error state */}
                                        {summaryErrors.get(t.filingUrl) &&
                                          !summaries.has(t.filingUrl) && (
                                            <div
                                              style={{
                                                padding: "8px 14px",
                                                color: "#ff8a8a",
                                                fontSize: 12,
                                                borderTop: "1px solid #1a2530",
                                              }}
                                            >
                                              {summaryErrors.get(t.filingUrl)}
                                            </div>
                                          )}
                                        {/* Summary panel */}
                                        {summaries.has(t.filingUrl) && (
                                          <SummaryPanel
                                            summary={summaries.get(t.filingUrl)!}
                                            isDeep={deepUrls.has(t.filingUrl)}
                                            onDeepAnalysis={() =>
                                              handleSummarize(
                                                t.id,
                                                t.filingUrl,
                                                t.filingType,
                                                true,
                                              )
                                            }
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

                  {currentTab === "8k" && company.eightKEvents && (
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
                                {e.textExcerpt.length > 200 ? e.textExcerpt.slice(0, 200) + "…" : e.textExcerpt}
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

                  {currentTab === "13f" && company.thirteenFHoldings && (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: "1px solid #2a3a4a", color: "#8ca2b8", textAlign: "left" }}>
                            <th style={{ padding: "8px" }}>Period</th>
                            <th style={{ padding: "8px" }}>Company</th>
                            <th style={{ padding: "8px" }}>CUSIP</th>
                            <th style={{ padding: "8px", textAlign: "right" }}>Shares</th>
                            <th style={{ padding: "8px", textAlign: "right" }}>Value (USD)</th>
                            <th style={{ padding: "8px", textAlign: "center" }}>Type</th>
                          </tr>
                        </thead>
                        <tbody>
                          {company.thirteenFHoldings.map((h) => (
                            <tr key={h.id} style={{ borderBottom: "1px solid #1a2530" }}>
                              <td style={{ padding: "8px", whiteSpace: "nowrap", color: "#9aa4ad" }}>
                                {h.periodOfReport}
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

                </div>
              )}
            </div>
          );
        })}
      </section>
    </main>
  );
}
