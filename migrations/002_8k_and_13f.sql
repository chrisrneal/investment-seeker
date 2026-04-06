-- Migration: Add tables for 8-K material events and 13F institutional holdings

-- ── 8-K material event filings ────────────────────────────────────────

CREATE TABLE events_8k (
  accession_no   text PRIMARY KEY,
  company_cik    text,                          -- nullable: not all filers are in companies table
  filer_name     text NOT NULL,
  ticker         text,
  filing_date    text NOT NULL,
  items          text[] NOT NULL DEFAULT '{}',  -- e.g. {'1.01','2.02'}
  primary_doc_url text,
  text_excerpt   text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_8k_company   ON events_8k(company_cik);
CREATE INDEX idx_events_8k_date      ON events_8k(filing_date DESC);
CREATE INDEX idx_events_8k_items     ON events_8k USING GIN(items);

-- ── 13F institutional holdings ────────────────────────────────────────

CREATE TABLE holdings_13f (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  accession_no          text NOT NULL,
  filer_cik             text,
  filer_name            text NOT NULL,
  period_of_report      text NOT NULL,
  filing_date           text NOT NULL,
  cusip                 text NOT NULL,
  company_name          text NOT NULL,
  value_usd             bigint NOT NULL DEFAULT 0,   -- value in thousands USD as reported
  shares                bigint NOT NULL DEFAULT 0,
  investment_discretion text,
  put_call              text,                        -- 'Put', 'Call', or NULL
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Use a functional unique index so that NULL put_call values are treated as equal
-- (two rows with the same accession_no, cusip, and NULL put_call are duplicates).
CREATE UNIQUE INDEX idx_holdings_13f_unique
  ON holdings_13f (accession_no, cusip, COALESCE(put_call, ''));

CREATE INDEX idx_holdings_13f_filer  ON holdings_13f(filer_cik);
CREATE INDEX idx_holdings_13f_cusip  ON holdings_13f(cusip);
CREATE INDEX idx_holdings_13f_period ON holdings_13f(period_of_report DESC);
