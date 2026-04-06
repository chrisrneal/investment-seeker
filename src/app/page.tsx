"use client";

import { useEffect, useState, useRef, useCallback } from "react";

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

type Company = {
  cik: string;
  name: string;
  ticker: string | null;
  latestTransactionDate: string | null;
  insiders: Insider[];
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

// ── Progress Bar ───────────────────────────────────────────────────

function ProgressBar({ job }: { job: IngestJob }) {
  const steps = job.steps ?? [];
  const currentIdx = job.currentStep ?? -1;
  const activeStep = currentIdx >= 0 ? steps[currentIdx] : undefined;

  // Overall progress: completed steps + fraction of current step
  const doneSteps = steps.filter((s) => s.status === "done").length;
  const stepFraction =
    activeStep?.progress && activeStep.progress.total > 0
      ? activeStep.progress.current / activeStep.progress.total
      : 0;
  const overallPct =
    steps.length > 0
      ? Math.round(((doneSteps + stepFraction) / steps.length) * 100)
      : 0;

  // Hung detection: no update in 90 seconds
  const elapsed = job.startedAt ? Math.floor((Date.now() - job.startedAt) / 1000) : 0;
  const stale = job.updatedAt ? (Date.now() - job.updatedAt) / 1000 : 0;
  const isHung = job.status === "running" && stale > 90;

  const barColor =
    job.status === "failed" ? "#d44" : job.status === "completed" ? "#4a4" : isHung ? "#d4a017" : "#1a6dd4";

  const formatElapsed = (s: number) => {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  };

  return (
    <div style={{ marginTop: 14 }}>
      {/* Step indicators */}
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

      {/* Bar */}
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

      {/* Detail line */}
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
              {activeStep.detail && activeStep.status !== "error" && !activeStep.progress && (
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
  const [hours, setHours] = useState(72);
  const [job, setJob] = useState<IngestJob | null>(null);
  const [ingestResult, setIngestResult] = useState<string | null>(null);
  const [ingestError, setIngestError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
            const failTotal = ((r?.ownershipFailed as number) ?? 0) + ((r?.eightKFailed as number) ?? 0) + ((r?.thirteenFFailed as number) ?? 0);
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

  // On mount, check if there's already a running job (e.g. page refresh)
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

  async function loadCompanies() {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch("/api/companies?limit=100");
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Failed to load");
      setCompanies(data.companies ?? []);
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
      else next.add(cik);
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
      <h1 style={{ fontSize: 28, margin: 0 }}>Investment Seeker</h1>
      <p style={{ color: "#9aa4ad", marginTop: 4 }}>
        Track insider transactions by company. See who&rsquo;s buying and selling.
      </p>

      {/* ── Ingest Panel ── */}
      <section style={{ ...panel, marginTop: 24 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Ingest Filings</h2>
        <p style={{ color: "#7a8a9a", fontSize: 13, marginTop: 4 }}>
          Pull insider ownership (Forms 3, 4, 5), 8-K events, and 13F-HR holdings from SEC EDGAR.
        </p>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginTop: 12 }}>
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
          <button onClick={loadCompanies} disabled={loading} style={btn("#2e3a4a")}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {/* ── Progress Bar ── */}
        {job && job.steps && (
          <ProgressBar job={job} />
        )}

        {ingestResult && <p style={{ color: "#6ecf8a", marginTop: 10, fontSize: 14 }}>{ingestResult}</p>}
        {ingestError && <p style={{ color: "#ff8a8a", marginTop: 10 }}>{ingestError}</p>}
      </section>

      {/* ── Companies Panel ── */}
      <section style={{ ...panel, marginTop: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
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
          const txnCount = company.insiders.reduce((n, i) => n + i.transactions.length, 0);
          return (
            <div key={company.cik} style={companyCard}>
              {/* Company header — clickable to expand */}
              <div
                onClick={() => toggleCompany(company.cik)}
                style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}
              >
                <div>
                  <strong style={{ fontSize: 16 }}>{company.name}</strong>
                  {company.ticker && (
                    <span style={{ color: "#7cc4ff", marginLeft: 10, fontWeight: 600 }}>{company.ticker}</span>
                  )}
                  {company.latestTransactionDate && (
                    <span style={{ color: "#7a8a9a", marginLeft: 10, fontSize: 13 }}>
                      Latest: {company.latestTransactionDate}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={badge("#1e2832")}>
                    {company.insiders.length} insider{company.insiders.length !== 1 ? "s" : ""}
                  </span>
                  <span style={badge("#1e2832")}>
                    {txnCount} txn{txnCount !== 1 ? "s" : ""}
                  </span>
                  <span style={{ color: "#7a8a9a", fontSize: 18 }}>{isOpen ? "▾" : "▸"}</span>
                </div>
              </div>

              {/* Expanded: show insiders + transactions */}
              {isOpen && (
                <div style={{ marginTop: 8 }}>
                  {company.insiders.length === 0 && (
                    <p style={{ color: "#7a8a9a", fontSize: 13, margin: "8px 0 0" }}>No insiders recorded.</p>
                  )}
                  {company.insiders.map((insider) => (
                    <div key={insider.cik} style={insiderBlock}>
                      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
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
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                            <thead>
                              <tr style={{ borderBottom: "1px solid #2a3a4a", color: "#8ca2b8", textAlign: "left" }}>
                                <th style={{ padding: "5px 8px" }}>Date</th>
                                <th style={{ padding: "5px 8px" }}>Form</th>
                                <th style={{ padding: "5px 8px" }}>Type</th>
                                <th style={{ padding: "5px 8px", textAlign: "right" }}>Shares</th>
                                <th style={{ padding: "5px 8px", textAlign: "right" }}>Price</th>
                                <th style={{ padding: "5px 8px", textAlign: "right" }}>Total</th>
                                <th style={{ padding: "5px 8px", textAlign: "right" }}>Held After</th>
                                <th style={{ padding: "5px 8px" }}></th>
                              </tr>
                            </thead>
                            <tbody>
                              {insider.transactions.map((t) => (
                                <tr key={t.id} style={{ borderBottom: "1px solid #1a2530" }}>
                                  <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>{t.transactionDate}</td>
                                  <td style={{ padding: "5px 8px" }}>
                                    <span style={badge("#1e2832")}>{t.filingType}</span>
                                  </td>
                                  <td style={{ padding: "5px 8px" }}>
                                    <span style={badge(txnColor[t.transactionType] ?? txnColor.other)}>
                                      {t.transactionType}
                                    </span>
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
                                  <td style={{ padding: "5px 8px" }}>
                                    <a href={t.filingUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#7cc4ff", fontSize: 11 }}>
                                      SEC↗
                                    </a>
                                  </td>
                                </tr>
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
                </div>
              )}
            </div>
          );
        })}
      </section>
    </main>
  );
}