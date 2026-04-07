-- Caches Yahoo Finance fundamentals per ticker with a 24-hour TTL enforced
-- in application code (scoreSignal.ts).

CREATE TABLE IF NOT EXISTS fundamentals_cache (
  ticker     TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE fundamentals_cache IS
  'Cached Yahoo Finance quoteSummary fundamentals (trailingPE, revenueGrowth, '
  'grossMargins, totalCash, debtToEquity). TTL: 24 hours enforced by app.';
