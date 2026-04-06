-- Migration: Add ticker, filing_type, and transactions columns to filing_summaries
-- These columns were referenced in the API but never formally added via migration.
ALTER TABLE filing_summaries ADD COLUMN IF NOT EXISTS ticker text;
ALTER TABLE filing_summaries ADD COLUMN IF NOT EXISTS filing_type text;
ALTER TABLE filing_summaries ADD COLUMN IF NOT EXISTS transactions jsonb DEFAULT '[]';
