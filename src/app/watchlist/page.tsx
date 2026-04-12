"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import type { User, Session } from "@supabase/supabase-js";
import type { WatchlistEntry } from "@/lib/types";

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

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function scoreColor(score: number | null): { bg: string; text: string } {
  if (score == null) return { bg: "#1e2832", text: "#9aa4ad" };
  if (score >= 75) return { bg: "#0d2d1a", text: "#6ecf8a" };
  if (score >= 50) return { bg: "#2a2000", text: "#ffd080" };
  if (score >= 25) return { bg: "#2a1500", text: "#ffa060" };
  return { bg: "#2d0d0d", text: "#ff8a8a" };
}

export default function WatchlistPage() {
  const supabaseRef = useRef(getSupabaseBrowserClient());
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    const sb = supabaseRef.current;
    sb.auth
      .getSession()
      .then(
        ({
          data: { session },
        }: {
          data: { session: Session | null };
        }) => {
          setUser(session?.user ?? null);
          setAuthLoading(false);
        }
      );
    const {
      data: { subscription },
    } = sb.auth.onAuthStateChange(
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
    const { error } = await sb.auth.signInWithPassword({
      email: authEmail,
      password: authPassword,
    });
    if (error) {
      setAuthError(error.message);
      return;
    }
    setAuthEmail("");
    setAuthPassword("");
  }

  async function handleLogout() {
    await supabaseRef.current.auth.signOut();
  }

  const isAuthenticated = !!user;

  // ── Watchlist state ────────────────────────────────────────────
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [addTicker, setAddTicker] = useState("");
  const [addThreshold, setAddThreshold] = useState(70);
  const [addError, setAddError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [editingThreshold, setEditingThreshold] = useState<
    Record<number, number>
  >({});

  async function loadWatchlist() {
    setLoading(true);
    try {
      const res = await fetch("/api/watchlist");
      if (res.ok) {
        const data = await res.json();
        setEntries(data);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const ticker = addTicker.trim().toUpperCase();
    if (!ticker) return;
    setAddError("");
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          alertThreshold: addThreshold,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddError(data.error ?? "Failed to add");
        return;
      }
      setAddTicker("");
      await loadWatchlist();
    } catch {
      setAddError("Network error");
    }
  }

  async function handleRemove(ticker: string) {
    try {
      await fetch(`/api/watchlist?ticker=${encodeURIComponent(ticker)}`, {
        method: "DELETE",
      });
      await loadWatchlist();
    } catch {
      // silent
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await fetch("/api/watchlist/refresh", { method: "POST" });
      await loadWatchlist();
    } catch {
      // silent
    } finally {
      setRefreshing(false);
    }
  }

  async function handleThresholdUpdate(
    id: number,
    ticker: string,
    value: number
  ) {
    try {
      const res = await fetch(
        `/api/watchlist?ticker=${encodeURIComponent(ticker)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alertThreshold: value }),
        }
      );
      if (res.ok) {
        const updated = await res.json();
        setEntries((prev) =>
          prev.map((e) =>
            e.id === id
              ? {
                  ...e,
                  alertThreshold: updated.alert_threshold,
                }
              : e
          )
        );
      }
    } catch {
      // silent
    }
    setEditingThreshold((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  useEffect(() => {
    if (isAuthenticated) void loadWatchlist();
  }, [isAuthenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  const inputStyle: React.CSSProperties = {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #2a3a4a",
    background: "#0e151d",
    color: "#e6e8eb",
    fontSize: 13,
  };

  return (
    <main
      style={{
        maxWidth: 920,
        margin: "0 auto",
        padding: "40px 20px 80px",
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 4,
            }}
          >
            <Link
              href="/"
              style={{
                color: "#7cc4ff",
                textDecoration: "none",
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              ← All Companies
            </Link>
          </div>
          <h1 style={{ fontSize: 28, margin: 0 }}>★ Watchlist</h1>
          <p style={{ color: "#9aa4ad", marginTop: 4 }}>
            Track tickers and get alerts when scores cross your threshold.
          </p>
        </div>

        {/* ── Auth Bar ── */}
        {!authLoading && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexShrink: 0,
            }}
          >
            {user ? (
              <>
                <span style={{ color: "#9aa4ad", fontSize: 13 }}>
                  {user.email}
                </span>
                <button
                  onClick={handleLogout}
                  style={{
                    ...btn("#2e3a4a"),
                    padding: "6px 12px",
                    fontSize: 12,
                  }}
                >
                  Sign Out
                </button>
              </>
            ) : (
              <form
                onSubmit={handleAuth}
                style={{
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <input
                  type="email"
                  placeholder="Email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  required
                  style={{ ...inputStyle, width: 160 }}
                />
                <input
                  type="password"
                  placeholder="Password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  required
                  minLength={6}
                  style={{ ...inputStyle, width: 120 }}
                />
                <button
                  type="submit"
                  style={{
                    ...btn("#1a6dd4"),
                    padding: "6px 12px",
                    fontSize: 12,
                  }}
                >
                  Sign In
                </button>
                {authError && (
                  <span style={{ color: "#ff8a8a", fontSize: 12 }}>
                    {authError}
                  </span>
                )}
              </form>
            )}
          </div>
        )}
      </div>

      {/* ── Content ── */}
      <div style={{ marginTop: 24 }}>
        {!isAuthenticated ? (
          <p style={{ color: "#9aa4ad", fontSize: 14 }}>
            Sign in to use your watchlist.
          </p>
        ) : (
          <>
            {/* Add form */}
            <form
              onSubmit={handleAdd}
              style={{
                display: "flex",
                gap: 8,
                marginBottom: 20,
                flexWrap: "wrap",
              }}
            >
              <input
                value={addTicker}
                onChange={(e) => setAddTicker(e.target.value.toUpperCase())}
                placeholder="Ticker (e.g. AAPL)"
                maxLength={10}
                style={{ ...inputStyle, width: 160 }}
              />
              <input
                type="number"
                min={0}
                max={100}
                value={addThreshold}
                onChange={(e) => setAddThreshold(Number(e.target.value))}
                placeholder="Alert threshold (0–100)"
                style={{ ...inputStyle, width: 180 }}
              />
              <button type="submit" style={btn("#1a6dd4")}>
                + Add
              </button>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing}
                style={{
                  ...btn("#1e2832"),
                  opacity: refreshing ? 0.6 : 1,
                }}
              >
                {refreshing ? "Refreshing…" : "↺ Refresh Scores"}
              </button>
            </form>
            {addError && (
              <p style={{ color: "#ff8a8a", fontSize: 13, marginBottom: 12 }}>
                {addError}
              </p>
            )}

            {/* Table */}
            {loading ? (
              <p style={{ color: "#7a8a9a", fontSize: 13 }}>
                Loading watchlist…
              </p>
            ) : entries.length === 0 ? (
              <p
                style={{
                  color: "#9aa4ad",
                  fontSize: 14,
                  textAlign: "center",
                  marginTop: 40,
                }}
              >
                No tickers yet. Add one above to start tracking.
              </p>
            ) : (
              <div style={{ overflowX: "auto" }}>
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
                        color: "#7a8a9a",
                        textAlign: "left",
                        borderBottom: "1px solid #1e2832",
                      }}
                    >
                      <th style={{ padding: "8px 10px" }}>Ticker</th>
                      <th style={{ padding: "8px 10px" }}>Company</th>
                      <th style={{ padding: "8px 10px" }}>Score</th>
                      <th style={{ padding: "8px 10px" }}>Threshold</th>
                      <th style={{ padding: "8px 10px" }}>Alert</th>
                      <th style={{ padding: "8px 10px" }}>Last Checked</th>
                      <th style={{ padding: "8px 10px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => {
                      const sc = scoreColor(
                        entry.currentScore != null
                          ? Number(entry.currentScore)
                          : null
                      );
                      return (
                        <tr
                          key={entry.id}
                          style={{
                            borderBottom: "1px solid #141e28",
                          }}
                        >
                          <td style={{ padding: "8px 10px" }}>
                            <Link
                              href={`/company/${entry.ticker}`}
                              style={{
                                color: "#7cc4ff",
                                textDecoration: "none",
                                fontWeight: 600,
                              }}
                            >
                              {entry.ticker}
                            </Link>
                          </td>
                          <td
                            style={{
                              padding: "8px 10px",
                              color: "#c8d4e0",
                            }}
                          >
                            {entry.companyName}
                          </td>
                          <td style={{ padding: "8px 10px" }}>
                            <span
                              style={{
                                ...badge(sc.bg),
                                color: sc.text,
                                fontWeight: 700,
                              }}
                            >
                              {entry.currentScore != null
                                ? Math.round(Number(entry.currentScore))
                                : "Not scored"}
                            </span>
                          </td>
                          <td style={{ padding: "8px 10px" }}>
                            <input
                              type="number"
                              min={0}
                              max={100}
                              value={
                                editingThreshold[entry.id] ??
                                entry.alertThreshold
                              }
                              onChange={(e) =>
                                setEditingThreshold((prev) => ({
                                  ...prev,
                                  [entry.id]: Number(e.target.value),
                                }))
                              }
                              onBlur={() =>
                                handleThresholdUpdate(
                                  entry.id,
                                  entry.ticker,
                                  editingThreshold[entry.id] ??
                                    entry.alertThreshold
                                )
                              }
                              style={{
                                ...inputStyle,
                                width: 60,
                                textAlign: "center",
                              }}
                            />
                          </td>
                          <td style={{ padding: "8px 10px" }}>
                            {entry.alertTriggered ? (
                              <span
                                style={{
                                  ...badge("#0d2d1a"),
                                  color: "#6ecf8a",
                                }}
                              >
                                🔔 Triggered
                              </span>
                            ) : (
                              <span
                                style={{
                                  ...badge("#1e2832"),
                                  color: "#9aa4ad",
                                }}
                              >
                                Watching
                              </span>
                            )}
                          </td>
                          <td
                            style={{
                              padding: "8px 10px",
                              color: "#7a8a9a",
                              fontSize: 12,
                            }}
                          >
                            {relativeTime(entry.lastCheckedAt)}
                          </td>
                          <td style={{ padding: "8px 10px" }}>
                            <button
                              onClick={() => handleRemove(entry.ticker)}
                              style={{
                                ...btn("transparent"),
                                padding: "4px 8px",
                                fontSize: 14,
                                color: "#ff8a8a",
                              }}
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
