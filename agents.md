---
applyTo: "**"
---

# Investment Seeker - Agent Instructions

## Self-Documentation Requirement

After every development task (feature addition, bug fix, refactor, configuration change, or any code modification), you **must** update the relevant documentation in this repository:

1. **Update `readme.md`** — Reflect any new features, setup changes, dependencies, or usage instructions resulting from the work.
2. **Update this file (`agents.md`)** — Record any new conventions, architectural decisions, project structure changes, or agent-specific context discovered during development.

## Documentation Update Checklist

After each development task, review and update as needed:

- [ ] `readme.md` reflects current project state, setup steps, and usage
- [ ] `agents.md` captures any new project conventions or architectural decisions
- [ ] Any new files or directories are documented in the project structure section below

## Project Structure

- `src/app/page.tsx` — Company-centric insider tracking UI (client component). Shows companies sorted by most recent insider transactions. Expandable company cards reveal insiders and their transaction history.
- `src/app/layout.tsx` — root layout.
- `src/app/api/filings/route.ts` — `GET /api/filings` endpoint (App Router route handler). Direct EDGAR search.
- `src/app/api/filings/ingest/route.ts` — `POST /api/filings/ingest` endpoint. Starts a background ingestion job (returns `jobId` immediately). `GET /api/filings/ingest?jobId=xxx` polls for progress. Fetches recent Forms 3, 4, 5, 8-K, and 13F-HR from EDGAR, parses each type's XML/HTML, and upserts into normalized tables: `companies`, `insiders`, `company_insiders`, `transactions`, `events_8k`, `holdings_13f`. Work continues server-side even if the client disconnects.
- `src/app/api/filings/ingest/8k/route.ts` — Standalone `POST /api/filings/ingest/8k` endpoint (also called by the unified ingest pipeline).
- `src/app/api/filings/ingest/13f/route.ts` — Standalone `POST /api/filings/ingest/13f` endpoint (also called by the unified ingest pipeline).
- `src/app/api/companies/route.ts` — `GET /api/companies` endpoint. Returns companies ordered by most recent transaction, with nested insiders and their transaction history.
- `src/app/api/summarize/route.ts` — `GET /api/summarize` endpoint. AI filing summarizer with two-tier model strategy (Haiku default, Sonnet for deep analysis). Caches results in Supabase.
- `src/lib/sec.ts` — SEC EDGAR client: token-bucket rate limiter (10 rps),
  `User-Agent` header, and `searchFilings()` against
  `https://efts.sec.gov/LATEST/search-index`.
- `src/lib/types.ts` — shared TypeScript types for filings, transactions, scores, summaries, and API errors.
- `src/lib/parseForm4.ts` — Ownership XML parser for Forms 3, 4, 5. Extracts issuer info, owner CIK/name/title/relationship, and structured transaction data. Flags notable transactions (open-market buys > $100K).
- `src/lib/scoreSignal.ts` — Signal scoring engine. Scores insider transactions 0–100 using cluster buying, insider role, purchase type, relative holdings, and price dip signals. Fetches 52-week price context from Yahoo Finance.
- `src/lib/anthropic.ts` — shared singleton Anthropic client instance.
- `src/lib/supabase.ts` — shared singleton Supabase client instance.
- `src/lib/ingestJobs.ts` — In-memory job store for tracking ingestion progress. Supports step-level tracking with sub-progress, hung detection, and TTL-based cleanup.
- `src/lib/costs.ts` — Anthropic API cost estimator from token usage. Accounts for prompt caching discounts.
- `scripts/migrate.ts` — Database migration runner. Reads SQL files from `migrations/`, tracks applied migrations in `_migrations` table.
- `migrations/001_normalized_schema.sql` — Creates normalized schema: `companies`, `insiders`, `company_insiders`, `transactions`. Drops old `filings` table.
- `vercel.json` — Vercel deployment config.
- `.env.example` — documents all required environment variables.

## Conventions & Decisions

- **Framework:** Next.js App Router + TypeScript. Node runtime for API routes
  (`export const runtime = "nodejs"`) because SEC calls require a custom
  `User-Agent` and Node `fetch`.
- **SEC fair access compliance is mandatory.** Any code making outbound SEC
  requests MUST go through `secFetch()` in [src/lib/sec.ts](src/lib/sec.ts) —
  never call `fetch` against `*.sec.gov` directly. This guarantees the
  token-bucket rate limit (≤10 req/s) and the required `User-Agent` header.
- **Filing type normalization:** the API accepts human aliases (`4`, `8k`,
  `13F`, …) which are mapped to EDGAR form codes in `FORM_ALIASES` in
  `src/app/api/filings/route.ts`. Add new supported forms there.
- **Sorting:** results are sorted by `filingDate` descending in
  `searchFilings()` so "recent" filings always come first.
- **Deployment:** Vercel, preferred via GitHub integration (push-to-deploy).
  Set all env vars (`SEC_USER_AGENT_EMAIL`, `ANTHROPIC_API_KEY`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) in Vercel project env vars
  before going live.
- **Database migrations:** Managed via `scripts/migrate.ts` and SQL files in
  `migrations/`. Run `npm run migrate` to apply pending migrations.
  Requires `DATABASE_URL` in `.env.local`. Migrations are tracked in a
  `_migrations` table.
- **Normalized data model:** Company → Insider → Transaction hierarchy.
  Companies and insiders are keyed by SEC CIK. The `company_insiders`
  junction table tracks roles. Transactions are individual trades parsed
  from ownership XML.
- **AI model strategy:** Two-tier approach for cost optimization. Haiku
  (`claude-haiku-4-5-20251001`) is the default for routine summaries. Sonnet
  (`claude-sonnet-4-6-20260401`) is used only when `deep_analysis=true`.
  The system prompt uses `cache_control: { type: "ephemeral" }` for prompt
  caching across requests.
- **Supabase caching:** `/api/summarize` checks Supabase for an existing
  summary before calling Claude. New summaries are stored after generation.
  Table schema is documented in `readme.md`. The route degrades gracefully
  if Supabase is unavailable (skips cache, still returns fresh summary).
- **Ownership form types:** Forms 3 (initial), 4 (changes), and 5
  (annual amendments) all use the same SEC ownership XML schema and
  are parsed by `parseForm4` in `src/lib/parseForm4.ts`. The ingest
  pipeline enriches all three with structured transaction data.
- **Form 4 XML parsing:** Uses lightweight regex-based XML extraction (no
  external XML library). Handles both `nonDerivativeTransaction` and
  `derivativeTransaction` blocks. Transaction code "P" = open-market
  purchase, "S"/"F" = sell, "M"/"A" = option exercise.
- **Signal scoring:** Five weighted signals summing to max 100. Price dip
  data comes from Yahoo Finance v8 chart API (free, no key required).
  Returns 0.5 (neutral) when price data is unavailable so the score
  degrades gracefully.
- **Shared type definitions:** All cross-module types live in
  `src/lib/types.ts`. Import from there rather than redefining types
  locally.
- **Consistent API error shape:** All API routes return
  `{ error: string, detail?: string }` on failure.
- **Background ingestion jobs:** Ingest endpoints use a fire-and-forget
  pattern with an in-memory job store (`src/lib/ingestJobs.ts`). POST
  returns a `jobId` immediately; GET polls for progress. The job store
  tracks steps, sub-progress, and timestamps for hung detection (90s
  staleness threshold). Jobs are cleaned up after 1 hour. Only one
  ingest job runs at a time — concurrent POSTs return the existing
  job's ID.
