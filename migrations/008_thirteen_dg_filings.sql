-- Stores parsed 13D and 13G activist filings (Schedule 13D / Schedule 13G).
-- Populated by the ingest pipeline; deduplicated on accession_no.

CREATE TABLE IF NOT EXISTS thirteen_dg_filings (
  id               BIGSERIAL    PRIMARY KEY,
  accession_no     TEXT         NOT NULL,
  filing_type      TEXT         NOT NULL,  -- 'SC 13D', 'SC 13G', 'SC 13D/A', 'SC 13G/A'
  filed_at         DATE         NOT NULL,
  filer_name       TEXT         NOT NULL,
  filer_cik        TEXT,
  subject_ticker   TEXT,
  subject_company  TEXT         NOT NULL DEFAULT '',
  percent_acquired NUMERIC(6,3),
  acquisition_date DATE,
  purpose_excerpt  TEXT         NOT NULL DEFAULT '',
  filing_link      TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT thirteen_dg_accession_key UNIQUE (accession_no)
);

CREATE INDEX IF NOT EXISTS thirteen_dg_subject_ticker_idx ON thirteen_dg_filings (subject_ticker);
CREATE INDEX IF NOT EXISTS thirteen_dg_filed_at_idx ON thirteen_dg_filings (filed_at DESC);

COMMENT ON TABLE thirteen_dg_filings IS
  'Activist ownership filings (SC 13D / SC 13G) from EDGAR. '
  'subject_ticker identifies the company being targeted. '
  'purpose_excerpt is up to 500 chars from Item 4 of the filing.';
