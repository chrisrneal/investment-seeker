-- Migration: Replace functional unique index on holdings_13f with a plain
-- unique constraint so that Supabase upsert ON CONFLICT works correctly.
--
-- The original index used COALESCE(put_call, '') to treat NULLs as equal,
-- but Supabase JS client can't reference functional indexes via onConflict.
-- Instead, we default put_call to '' and add a normal unique constraint.

-- 1. Backfill existing NULL put_call rows to empty string
UPDATE holdings_13f SET put_call = '' WHERE put_call IS NULL;

-- 2. Set a column default so new rows never get NULL
ALTER TABLE holdings_13f ALTER COLUMN put_call SET DEFAULT '';
ALTER TABLE holdings_13f ALTER COLUMN put_call SET NOT NULL;

-- 3. Drop the functional index
DROP INDEX IF EXISTS idx_holdings_13f_unique;

-- 4. Add a plain unique constraint the Supabase client can reference
ALTER TABLE holdings_13f
  ADD CONSTRAINT holdings_13f_accession_cusip_putcall_key
  UNIQUE (accession_no, cusip, put_call);
