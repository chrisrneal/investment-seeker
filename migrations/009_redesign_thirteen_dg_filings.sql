-- Redesign thirteen_dg_filings with richer schema for activist analysis.
-- Drops and recreates the table with new column names and additional fields.
-- Data can be re-ingested via the ingest pipeline.

DROP TABLE IF EXISTS thirteen_dg_filings CASCADE;

CREATE TABLE thirteen_dg_filings (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  accession_no           TEXT        NOT NULL,
  filer_name             TEXT        NOT NULL,
  filer_cik              TEXT,
  subject_company_name   TEXT        NOT NULL DEFAULT '',
  subject_company_ticker TEXT,
  subject_company_cik    TEXT,
  filing_date            TEXT        NOT NULL,
  filed_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  percent_of_class       NUMERIC,
  aggregate_amount       NUMERIC,
  amendment_type         TEXT,
  item4_excerpt          TEXT,
  primary_doc_url        TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT thirteen_dg_accession_unique UNIQUE (accession_no)
);

CREATE INDEX IF NOT EXISTS thirteen_dg_subject_company_ticker_idx
  ON thirteen_dg_filings (subject_company_ticker);
CREATE INDEX IF NOT EXISTS thirteen_dg_filing_date_idx
  ON thirteen_dg_filings (filing_date DESC);

COMMENT ON TABLE thirteen_dg_filings IS
  'Activist ownership filings (SC 13D / SC 13G) from EDGAR. '
  'subject_company_ticker identifies the company being targeted. '
  'item4_excerpt is up to 1,500 chars from Item 4 (Purpose of Transaction). '
  'amendment_type is non-null for SC 13D/A and SC 13G/A amendments.';
