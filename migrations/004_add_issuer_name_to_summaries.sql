-- Migration: Add missing issuer_name column to filing_summaries
ALTER TABLE filing_summaries ADD COLUMN IF NOT EXISTS issuer_name text;
