-- Migration: Normalize from flat filings table to company → insider → transaction hierarchy

-- ── New tables ─────────────────────────────────────────────────────

-- Companies (issuers), keyed by SEC CIK
CREATE TABLE companies (
  cik text PRIMARY KEY,
  name text NOT NULL,
  ticker text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Insiders (reporting owners), keyed by their own SEC CIK
CREATE TABLE insiders (
  cik text PRIMARY KEY,
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Junction: which insiders belong to which companies, with role info
CREATE TABLE company_insiders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_cik text NOT NULL REFERENCES companies(cik) ON DELETE CASCADE,
  insider_cik text NOT NULL REFERENCES insiders(cik) ON DELETE CASCADE,
  title text,
  relationship text,  -- 'director', 'officer', 'tenPercentOwner', 'other'
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_cik, insider_cik)
);

-- Individual transactions parsed from ownership filings
CREATE TABLE transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  accession_no text NOT NULL,
  company_cik text NOT NULL REFERENCES companies(cik) ON DELETE CASCADE,
  insider_cik text NOT NULL REFERENCES insiders(cik) ON DELETE CASCADE,
  filing_type text NOT NULL,          -- '3', '4', '5'
  filing_url text NOT NULL,
  transaction_date text NOT NULL,
  transaction_type text NOT NULL,     -- 'buy', 'sell', 'exercise', 'other'
  transaction_code text,              -- 'P', 'S', 'M', 'A', 'F', etc.
  shares numeric NOT NULL DEFAULT 0,
  price_per_share numeric NOT NULL DEFAULT 0,
  total_value numeric NOT NULL DEFAULT 0,
  shares_owned_after numeric NOT NULL DEFAULT 0,
  is_direct_ownership boolean DEFAULT true,
  filed_at text NOT NULL,             -- filing_date from EDGAR
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Prevent duplicate transactions from re-ingests
  UNIQUE (accession_no, transaction_date, transaction_code, shares, insider_cik)
);

-- ── Indexes for common queries ─────────────────────────────────────

CREATE INDEX idx_transactions_company ON transactions(company_cik);
CREATE INDEX idx_transactions_insider ON transactions(insider_cik);
CREATE INDEX idx_transactions_date ON transactions(transaction_date DESC);
CREATE INDEX idx_transactions_type ON transactions(transaction_type);
CREATE INDEX idx_company_insiders_company ON company_insiders(company_cik);

-- ── Drop old flat table ────────────────────────────────────────────

DROP TABLE IF EXISTS filings;
