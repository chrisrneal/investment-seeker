-- Stores MD&A excerpts from 10-Q (quarterly) and 10-K (annual) SEC filings.
-- Populated by the ingest pipeline; deduplicated on (ticker, form_type, filing_date).

CREATE TABLE IF NOT EXISTS annual_filings (
  id               BIGSERIAL   PRIMARY KEY,
  ticker           TEXT        NOT NULL,
  form_type        TEXT        NOT NULL,
  filing_date      DATE        NOT NULL,
  period_of_report DATE,
  primary_doc_url  TEXT,
  mda_excerpt      TEXT        NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT annual_filings_ticker_form_date_key
    UNIQUE (ticker, form_type, filing_date)
);

CREATE INDEX IF NOT EXISTS annual_filings_ticker_idx ON annual_filings (ticker);
CREATE INDEX IF NOT EXISTS annual_filings_filing_date_idx ON annual_filings (filing_date DESC);

COMMENT ON TABLE annual_filings IS
  'MD&A excerpts from SEC 10-Q/10-K filings. '
  'Unique on (ticker, form_type, filing_date). '
  'mda_excerpt is up to 3,000 chars from the Item 2 (or Item 7 for 10-K) section.';
