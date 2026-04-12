-- Cache tables for the four AI analysis features.
-- TTL enforcement is done in application code.

CREATE TABLE IF NOT EXISTS composite_score_cache (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticker      TEXT        NOT NULL UNIQUE,
  total       NUMERIC     NOT NULL,
  breakdown   JSONB       NOT NULL,
  fundamentals JSONB      NOT NULL,
  insider_signal JSONB    NOT NULL,
  rationale   TEXT        NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS earnings_sentiment_cache (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticker      TEXT        NOT NULL UNIQUE,
  result      JSONB       NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activist_analysis_cache (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticker      TEXT        NOT NULL UNIQUE,
  result      JSONB       NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_flag_cache (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticker      TEXT        NOT NULL UNIQUE,
  result      JSONB       NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
