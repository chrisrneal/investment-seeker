---
applyTo: "**"
---

# Investment Seeker - Agent Instructions

## Self-Documentation Requirement

After every development task (feature addition, bug fix, refactor, configuration change, or any code modification), you **must** update the relevant documentation in this repository:

1. **Update `readme.md`** — Reflect any new features, setup changes, dependencies, or usage instructions resulting from the work.
2. **Update this file (`agents.md`)** — Record any new conventions, architectural decisions, project structure changes, or agent-specific context discovered during development.

## Pre-PR Checklist

Before opening or updating any pull request, you **must** complete all of the following steps in order:

1. **Run migrations** — if any new SQL files were added to `migrations/`, apply them:
   ```
   npm run migrate
   ```
   Verify the output shows all pending migrations applied with ✅. Fix any errors before continuing.

2. **Build the app** — confirm the production build compiles cleanly with no TypeScript errors:
   ```
   npm run build
   ```
   The build must complete without errors. Resolve any type errors or compilation failures before opening a PR.

Only proceed to open the PR after both commands succeed.

## Documentation Update Checklist

After each development task, review and update as needed:

- [ ] `readme.md` reflects current project state, setup steps, and usage
- [ ] `agents.md` captures any new project conventions or architectural decisions
- [ ] Any new files or directories are documented in the project structure section below

## Project Structure

- `src/app/page.tsx` — Company-centric insider tracking UI (client component). Shows companies sorted by most recent insider transactions, paginated at 20 per page with prev/next navigation. Expandable company cards reveal insiders and their transaction history. Includes a ticker search bar to load filings for a specific company (last 30 days), plus broad ingest controls. Includes full AI summary integration: per-row `▾ AI` / `🔬` buttons, inline expandable summary panels, company-level "Summarize All" batch action, and a company overview block aggregating loaded summaries.
- `src/app/layout.tsx` — root layout.
- `src/app/api/filings/route.ts` — `GET /api/filings` endpoint (App Router route handler). Direct EDGAR search.
- `src/app/api/filings/ingest/route.ts` — `POST /api/filings/ingest` endpoint. Starts a background ingestion job (returns `jobId` immediately). `GET /api/filings/ingest?jobId=xxx` polls for progress. Fetches recent Forms 3, 4, 5, 8-K, and 13F-HR from EDGAR, parses each type's XML/HTML, and upserts into normalized tables: `companies`, `insiders`, `company_insiders`, `transactions`, `events_8k`, `holdings_13f`. Work continues server-side even if the client disconnects. Supports optional `ticker` query param to scope the search to a single company (defaults to 30-day window).
- `src/app/api/filings/ingest/8k/route.ts` — Standalone `POST /api/filings/ingest/8k` endpoint (also called by the unified ingest pipeline).
- `src/app/api/filings/ingest/13f/route.ts` — Standalone `POST /api/filings/ingest/13f` endpoint (also called by the unified ingest pipeline).
- `src/app/api/companies/route.ts` — `GET /api/companies` endpoint. Returns companies ordered by most recent transaction, with nested insiders and their transaction history. Also joins `filing_summaries` to include any cached AI summaries keyed by filing URL in the response.
- `src/app/api/companies/[ticker]/route.ts` — `GET /api/companies/[ticker]` endpoint. Returns a single company by ticker symbol (case-insensitive) with insiders, transactions, 8-K events, 13F holdings, and cached AI summaries. Returns 404 if ticker not found.
- `src/app/company/[ticker]/page.tsx` — Company detail page (client component). Shows a single company's full details including insiders, transactions, 8-K events, 13F holdings, and AI summary integration. Redirects to home with error banner if ticker not found.
- `src/app/api/summarize/route.ts` — `GET /api/summarize` endpoint. **Requires authentication.** AI filing summarizer with two-tier model strategy (Haiku default, Sonnet for deep analysis). Verifies Supabase session via `getAuthUser()` before proceeding. Caches results in Supabase.
- `src/app/auth/callback/route.ts` — OAuth/email confirmation callback. Exchanges the `code` query param for a Supabase session and sets cookies.
- `src/lib/auth.ts` — Server-side auth helper. `getAuthUser(req)` verifies the Supabase session cookie and returns the `User` or `null`. `unauthorizedResponse()` returns a standard 401 JSON.
- `src/lib/supabase-browser.ts` — Browser-side Supabase client using `@supabase/ssr`. Uses `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- `src/lib/sec.ts` — SEC EDGAR client: token-bucket rate limiter (10 rps),
  `User-Agent` header, and `searchFilings()` against
  `https://efts.sec.gov/LATEST/search-index`.
- `src/lib/types.ts` — shared TypeScript types for filings, transactions, scores, summaries, and API errors.
- `src/lib/parseForm4.ts` — Ownership XML parser for Forms 3, 4, 5. Extracts issuer info, owner CIK/name/title/relationship, and structured transaction data. Flags notable transactions (open-market buys > $100K).
- `src/lib/sec.ts` — SEC EDGAR client. Also exports `fetchAnnualFilingDoc(filing, ticker)` (processes one 10-Q/10-K filing result into an `AnnualFilingResult`) and `fetchAnnualFilings(ticker)` (last 4 quarterly + 2 annual filings for a specific ticker, with MD&A extraction).
- `src/lib/scoreSignal.ts` — Signal scoring engine. Scores insider transactions 0–100 using cluster buying, insider role, purchase type, relative holdings, and price dip signals. Fetches 52-week price context from Yahoo Finance v8 chart API and company fundamentals (trailingPE, revenueGrowth, grossMargins, totalCash, debtToEquity) from Yahoo Finance v10 quoteSummary API. Fundamentals are cached in `fundamentals_cache` with a 24-hour TTL.
- `src/lib/anthropic.ts` — shared singleton Anthropic client instance.
- `src/lib/supabase.ts` — shared singleton Supabase client instance.
- `src/lib/ingestJobs.ts` — In-memory job store for tracking ingestion progress. Supports step-level tracking with sub-progress, hung detection, and TTL-based cleanup.
- `src/lib/costs.ts` — Anthropic API cost estimator from token usage. Accounts for prompt caching discounts.
- `scripts/migrate.ts` — Database migration runner. Reads SQL files from `migrations/`, tracks applied migrations in `_migrations` table.
- `migrations/001_normalized_schema.sql` — Creates normalized schema: `companies`, `insiders`, `company_insiders`, `transactions`. Drops old `filings` table.
- `migrations/006_fundamentals_cache.sql` — Creates `fundamentals_cache` table (ticker PK, data JSONB, fetched_at). Stores Yahoo Finance quoteSummary fundamentals with 24h TTL enforced in app code.
- `migrations/007_annual_filings.sql` — Creates `annual_filings` table with columns: ticker, form_type, filing_date, period_of_report, primary_doc_url, mda_excerpt. Unique on (ticker, form_type, filing_date). Populated by the ingest pipeline.
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
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`) in Vercel project env vars
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
- **Summary preloading:** `/api/companies` joins `filing_summaries` on
  filing URLs and returns a `summaries` dict (keyed by filing URL) alongside
  company data. The frontend pre-populates its summary Map on load so
  previously-summarized filings display instantly without re-calling Claude.
  Buttons show `✦ AI` instead of `▾ AI` when a cached summary is available.
- **Authentication:** AI features (summarization) are gated behind Supabase
  Auth. The browser client (`src/lib/supabase-browser.ts`) manages sessions
  via `@supabase/ssr`. API routes verify session cookies using
  `getAuthUser()` from `src/lib/auth.ts`. The `/auth/callback` route handles
  email confirmation code exchange. UI buttons are disabled when not
  authenticated. Environment needs `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the URL is shared by both browser and
  server clients).
- **Frontend summary state:** Summaries are stored in `Map<string, FilingSummary>` keyed by `filingUrl`. Loading state is tracked per-URL with a `Set<string>`. Expanded panels are tracked per transaction ID (`Set<number>`) so rows sharing the same filing URL can independently show/hide their panel. Deep analysis URLs are tracked in a separate `Set<string>`. All state lives in the `Home` component to persist across expand/collapse cycles.
- **Summary deduplication:** `handleSummarize` checks `summaryLoading` before firing a fetch — if the URL is already in flight, no duplicate request is made. `summarizeCompany` pre-computes `toFetch` synchronously (before any awaits) using a `seenUrls` set to ensure each URL appears at most once in the batch.
- **React Fragment in table body:** Transaction rows use `<Fragment key={t.id}>` to render an optional summary `<tr>` after each data row without breaking HTML table structure. `Fragment` is imported from React directly (not the `<>` shorthand, which doesn't support `key`).
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
  degrades gracefully. Fundamentals (trailingPE, revenueGrowth, grossMargins,
  totalCash, debtToEquity) are fetched in parallel from Yahoo Finance v10
  quoteSummary and attached to `ScoredSignal.fundamentals`. Results are cached
  in the `fundamentals_cache` Supabase table for 24 hours. Both the price and
  fundamentals fetches degrade gracefully (`null`) if unavailable.
- **FundamentalsSnapshot type:** All fundamentals fields are `number | null`
  to handle tickers where Yahoo Finance omits certain fields. Always check for
  null before rendering or computing with these values.
- **Annual filings (10-Q/10-K):** The ingest pipeline step "Fetch annual filings" runs after the 13F step. With a ticker it calls `fetchAnnualFilings(ticker)` (last 4 Q + 2 K). Without a ticker it searches a 1-year window (25 Q + 25 K, capped). Results are stored in `annual_filings` via upsert on `(ticker, form_type, filing_date)`.
- **MD&A extraction:** `extractMdaExcerpt` in `sec.ts` searches plain text for an "Item 2" header (with "Management" or "Discussion" nearby), then takes up to 3,000 characters until the next "Item 3". For 10-K filings where Item 2 isn't found, it falls back to Item 7. Last resort: first 3,000 characters of the document.
- **10-Q/10-K filing type aliases:** `FORM_ALIASES` in `/api/filings/route.ts` maps "10-q", "10q", "10-k", "10k" to "10-Q"/"10-K" respectively, making them searchable via `GET /api/filings?type=10-q`.
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
- **Clickable tickers:** Company tickers on the home page are Next.js
  `<Link>` elements pointing to `/company/[ticker]`. The company detail
  page fetches data from `/api/companies/[ticker]`. If a ticker is not
  found (404), the page redirects to `/` with an `?error=` query param
  that shows a dismissable error banner.
- **Suspense boundary for useSearchParams:** The home page uses
  `useSearchParams()` to read the `?error=` query param. Next.js requires
  this to be wrapped in a `<Suspense>` boundary. The exported `Home`
  component wraps `HomeContent` in Suspense.
- **Client-side pagination:** The companies list on the home page is
  paginated at 20 items per page. All companies are fetched in a single
  API call (up to 100) and sliced client-side. Pagination controls appear
  at both the top and bottom of the list. Page resets to 1 on data reload.
  Bottom pagination buttons auto-scroll to the top of the page.
