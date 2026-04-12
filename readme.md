# Investment Seeker

A Next.js (App Router) application for monitoring SEC insider trading activity with AI-powered analysis.

## API Endpoints

### GET /api/filings

Search recent SEC filings from the EDGAR full-text search index.

```
GET /api/filings?type=<4|8-K|13F>&ticker=<TICKER>&limit=<1-100>
```

- `type` (required) — filing form. Accepted aliases: `3`, `form3`, `4`, `form4`, `5`, `form5`, `8-K`, `8k`, `13F`, `13F-HR`, `13F-NT`.
- `ticker` (optional) — company ticker, e.g. `AAPL`.
- `limit` (optional) — 1–100, default 20.

#### Response

```json
{
  "query": { "type": "4", "ticker": "AAPL", "limit": 20 },
  "count": 20,
  "results": [
    {
      "filerName": "APPLE INC",
      "ticker": "AAPL",
      "filingDate": "2025-01-15",
      "filingType": "4",
      "link": "https://www.sec.gov/Archives/edgar/data/320193/.../...-index.htm",
      "accessionNo": "0000000000-00-000000",
      "cik": "0000320193"
    }
  ]
}
```

### POST /api/filings/ingest

Fetches all recent SEC filings — insider ownership (Forms 3, 4, 5), 8-K events, and 13F-HR institutional holdings — parses each type, and upserts into the database in one unified pipeline.

The endpoint runs the work **server-side in the background** — the POST returns immediately with a `jobId`, and the actual ingestion continues even if the client disconnects. Poll the GET endpoint for progress.

```
POST /api/filings/ingest?hours=24
POST /api/filings/ingest?ticker=AAPL
```

- `hours` (optional) — time window in hours. Defaults to 24 for broad ingests (max 168), or 720 (30 days) for ticker searches (max 720).
- `ticker` (optional) — company ticker symbol (e.g. `AAPL`). When provided, only filings matching that ticker are fetched. The completed job result includes `ticker` and `totalFilingsFetched` so the client can detect when no filings were found.

#### Response

```json
{ "jobId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }
```

### GET /api/filings/ingest

Poll ingestion job progress. Returns the current step, sub-progress, and timing info.

```
GET /api/filings/ingest?jobId=<JOB_ID>
```

- `jobId` (optional) — if omitted, returns any currently running job (useful after a page refresh).

#### Response (running)

```json
{
  "id": "...",
  "status": "running",
  "steps": [
    { "label": "Fetching Form 3 filings", "status": "done" },
    { "label": "Fetching Form 4 filings", "status": "done" },
    { "label": "Fetching Form 5 filings", "status": "done" },
    { "label": "Fetching 8-K filings", "status": "done" },
    { "label": "Fetching 13F-HR filings", "status": "done" },
    { "label": "Parsing ownership XML", "status": "active", "progress": { "current": 120, "total": 500 } },
    { "label": "Parsing 8-K filings", "status": "pending" },
    { "label": "Parsing 13F-HR filings", "status": "pending" },
    { "label": "Saving to database", "status": "pending" }
  ],
  "currentStep": 3,
  "startedAt": 1712345678000,
  "updatedAt": 1712345690000
}
```

#### Response (completed)

```json
{
  "id": "...",
  "status": "completed",
  "result": {
    "ownershipParsed": 102,
    "ownershipFailed": 3,
    "companies": 85,
    "insiders": 98,
    "transactions": 264,
    "eightKEvents": 340,
    "eightKFailed": 5,
    "thirteenFHoldings": 1200,
    "thirteenFFailed": 2
  }
}
```

### GET /api/companies

Returns companies ordered by most recent insider transaction. Each company includes its insiders and their transaction history.

```
GET /api/companies?limit=50
```

- `limit` (optional) — 1–200, default 50.

### GET /api/companies/[ticker]

**Requires authentication.** Returns a single company by ticker symbol with its insiders, transactions, 8-K events, 13F holdings (with filer name and investment discretion), 13D/G activist filings, annual filings (10-Q/10-K MD&A excerpts), cached AI summaries, fundamentals (from cache), short interest, and a computed insider signal score (0–100). Returns `404` if the ticker is not found.

```
GET /api/companies/AAPL
```

The response includes:
- `company` — full company data with nested insiders, transactions, 8-K events, 13F holdings, 13D/G filings, and annual filings
- `summaries` — cached AI summaries keyed by filing URL
- `fundamentals` — cached Yahoo Finance metrics (P/E, revenue growth, gross margins, cash, D/E) or null
- `shortInterest` — short % of float and days to cover from Yahoo Finance, or null
- `signalScore` — computed 0–100 insider conviction score with breakdown and rationale, or null

### GET /api/signal/composite

**Requires authentication.** Computes a Composite Conviction Score (0–100) combining the Insider Conviction Score with fundamentals quality, valuation, and catalyst signals. Results are cached for 6 hours.

```
GET /api/signal/composite?ticker=AAPL
```

#### Response

```json
{
  "ticker": "AAPL",
  "total": 72,
  "breakdown": {
    "insiderConvictionScore": 28,
    "fundamentalsScore": 19,
    "valuationScore": 15,
    "catalystScore": 10
  },
  "fundamentals": { "trailingPE": 28.4, "revenueGrowth": 0.08, "grossMargins": 0.46, ... },
  "insiderSignal": { "score": 70, "rationale": "...", "breakdown": { ... } },
  "rationale": "Moderate composite signal (72/100). ICS 70/100 → 28/40 pts. Strong fundamentals (8% rev growth, 46% gross margin).",
  "computedAt": "2026-04-12T10:00:00.000Z",
  "cached": false
}
```

Scoring breakdown:
| Component | Max pts | Signals |
|---|---|---|
| Insider Conviction | 40 | Existing ICS × 0.40 |
| Fundamentals | 25 | Revenue growth + gross margins + debt-to-equity |
| Valuation | 20 | Trailing P/E bands (deep value = 20, growth = 8) |
| Catalyst | 15 | Short squeeze setup + activist filer bonus |

### POST /api/filings/annual

**Requires authentication.** Fetches the last 4 quarterly (10-Q) and 2 annual (10-K) filings for a ticker from EDGAR, extracts MD&A excerpts, and upserts into the `annual_filings` table.

```
POST /api/filings/annual?ticker=AAPL
```

#### Response

```json
{ "ticker": "AAPL", "ingested": 6 }
```

### GET /api/analyze/earnings-sentiment

**Requires authentication.** Compares the two most recent MD&A sections for a ticker using Claude Sonnet to detect tone shifts, new risk language, and management confidence signals. Cached for 24 hours. If fewer than 2 filings exist, returns `sentimentDelta: "insufficient_data"` with a suggestion to run `POST /api/filings/annual` first.

```
GET /api/analyze/earnings-sentiment?ticker=AAPL
```

#### Response

```json
{
  "ticker": "AAPL",
  "sentimentDelta": "improving",
  "keyThemeChanges": ["Services revenue growth now primary narrative", "Supply chain risk language removed"],
  "redFlags": [],
  "confidenceSignals": ["Full-year guidance reaffirmed", "Buyback program expanded"],
  "quarterCompared": "Q1 2026 vs Q4 2025",
  "modelUsed": "claude-sonnet-4-6-20260401",
  "estimatedCost": 0.000842,
  "cached": false
}
```

### GET /api/analyze/earnings-sentiment

### GET /api/analyze/risk-flags

**Requires authentication.** Scans the most recent 10-K (or 10-Q fallback) for 10 categories of structural red flags using Claude Haiku. Cached for 24 hours. Returns 404 if no filings are found — run `POST /api/filings/annual` first.

```
GET /api/analyze/risk-flags?ticker=AAPL
```

#### Response

```json
{
  "ticker": "AAPL",
  "flags": [
    { "category": "Revenue concentration", "severity": "medium", "evidence": "One customer represents 22% of net revenue" }
  ],
  "overallRiskLevel": "medium",
  "filingScanned": "2025-09-30",
  "modelUsed": "claude-haiku-4-5-20251001",
  "estimatedCost": 0.000215,
  "cached": false
}
```

Risk flag categories scanned: Going concern, Covenant violation, Goodwill impairment, Revenue concentration, Planned dilution, Insider share pledge, Auditor change, Material weakness, Liquidity risk, Litigation risk.

Severity rules: `high` = immediate financial risk, `medium` = structural concern, `low` = minor disclosure. `overallRiskLevel` is `critical` if any high flags present, `high` if 3+ medium, `medium` if 1–2 medium, `low` otherwise.

### GET /api/analyze/activist

**Requires authentication.** Analyzes 13D/G Item 4 "Purpose of Transaction" excerpts using Claude Sonnet to classify the activist thesis, extract demands, and assess tone. Cached for 12 hours in a dedicated `activist_analysis_cache` table.

```
GET /api/analyze/activist?ticker=AAPL
```

#### Response

```json
{
  "ticker": "AAPL",
  "thesisCategory": "Capital Return / Buyback",
  "specificDemands": ["Accelerate share repurchase program", "..."],
  "timelineSignals": ["Annual meeting deadline: April 2026"],
  "tone": "cooperative",
  "catalystRisk": "Board may reject demands without a proxy fight threat",
  "convergenceNote": null,
  "filerCount": 1,
  "totalPercentDisclosed": 8.2,
  "oldestFilingDate": "2025-11-14",
  "modelUsed": "claude-sonnet-4-6-20260401",
  "estimatedCost": 0.000634,
  "cached": false
}
```

Thesis categories: `Operational Improvement`, `Board Reconstitution`, `Strategic Sale / M&A`, `Capital Return / Buyback`, `Management Change`, `Business Separation / Spin-off`, `Balance Sheet Restructuring`, `Undervaluation / Passive Accumulation`.

### GET /api/signal/recommendation

**Requires authentication.** AI-powered buy/hold/sell recommendation engine using Claude Sonnet. Assembles all cached signal data (composite score, earnings sentiment, risk flags, activist analysis, recent transactions) into a structured context, then generates a recommendation with confidence level, thesis, position sizing, and risk assessment. Cached for 6 hours.

```
GET /api/signal/recommendation?ticker=AAPL
```

#### Response

```json
{
  "ticker": "AAPL",
  "verdict": "BUY",
  "confidenceLevel": 4,
  "thesis": "Strong insider buying cluster with improving fundamentals...",
  "timeHorizon": "6-12 months",
  "positionSizing": {
    "suggestedAllocationPercent": 5,
    "rationale": "High conviction signal with moderate risk profile"
  },
  "risks": ["Revenue concentration risk", "Elevated valuation"],
  "catalysts": ["Upcoming earnings report", "Insider cluster buying"],
  "signalSummary": {
    "compositeScore": 72,
    "insiderConviction": 85,
    "sentimentDelta": "improving",
    "riskLevel": "medium",
    "activistPresent": false
  },
  "modelUsed": "claude-sonnet-4-6-20260401",
  "estimatedCost": 0.001234,
  "cached": false
}
```

Verdicts: `STRONG_BUY`, `BUY`, `HOLD`, `SELL`, `STRONG_SELL`. Confidence: 1–5 (5 = highest).

### GET /api/analyze/adversarial

**Requires authentication.** Adversarial bear/bull Red-Team debate using two sequential Claude Sonnet calls. The bear analyst argues against the position, then the bull analyst rebuts. Debate verdict is determined algorithmically based on the existing recommendation. Cached for 12 hours.

```
GET /api/analyze/adversarial?ticker=AAPL
```

#### Response

```json
{
  "ticker": "AAPL",
  "bearCase": {
    "keyRisks": ["Valuation premium unsustainable", "Services growth slowing"],
    "worstCaseScenario": "Multiple compression to 20x PE = 30% downside",
    "failureMode": "Growth deceleration below market expectations",
    "probabilityOfLoss": 25
  },
  "bullRebuttal": {
    "counterArguments": ["Installed base of 2B+ devices provides recurring revenue"],
    "mitigatingFactors": ["$100B+ cash position", "Strong buyback program"],
    "upside": "AI integration drives new product cycle → 25% upside"
  },
  "debateVerdict": "bull_wins",
  "debateVerdictRationale": "Bull case more persuasive given ...",
  "modelUsed": "claude-sonnet-4-6-20260401",
  "estimatedCost": 0.002100,
  "cached": false
}
```

### GET/POST/DELETE/PATCH /api/watchlist

**Requires authentication.** CRUD operations for the user's watchlist.

```
GET    /api/watchlist                          # list all entries
POST   /api/watchlist   { "ticker": "AAPL", "alertThreshold": 70 }
DELETE /api/watchlist    { "ticker": "AAPL" }
PATCH  /api/watchlist    { "ticker": "AAPL", "alertThreshold": 80 }
```

Each entry tracks: ticker, alert threshold (0–100), current composite score, whether the alert has been triggered, and timestamps.

### POST /api/watchlist/refresh

**Requires authentication.** Refreshes composite scores for all watchlist entries (max 10) from the `composite_score_cache` table. Does not call external APIs — only reads cached data. Updates `current_score`, `alert_triggered`, and `last_checked_at`.

```
POST /api/watchlist/refresh
```

### POST /api/export/memo

**Requires authentication.** Generates a `.docx` research memo for a ticker. Uses Claude Sonnet to produce structured memo sections (Executive Summary, Signal Summary, Risk Assessment, Investment Thesis, Recommendation), then builds a Word document with the `docx` library. Returns the binary file directly.

```
POST /api/export/memo?ticker=AAPL
```

Response: `application/vnd.openxmlformats-officedocument.wordprocessingml.document` binary with `Content-Disposition: attachment`.

### GET /api/summarize

**Requires authentication.** AI-powered filing summarizer using the Anthropic API with a two-tier model strategy. Returns `401` if the request has no valid Supabase session.

```
GET /api/summarize?url=<SEC_FILING_URL>&deep_analysis=<true|false>&filing_type=<3|4|5|8-K|13F>
```

- `url` (required) — URL to an SEC filing on sec.gov.
- `deep_analysis` (optional) — `true` to use Claude Sonnet for deeper analysis (mergers, restatements). Defaults to Haiku.
- `filing_type` (optional) — hints the model about the form type.

#### Response

```json
{
  "summary": "...",
  "impactRating": "Positive",
  "flags": ["Notable insider buying activity"],
  "ticker": "AAPL",
  "issuerName": "Apple Inc",
  "filingType": "4",
  "transactions": [],
  "modelUsed": "claude-haiku-4-5-20251001",
  "estimatedCost": 0.000342,
  "cached": false
}
```

Summaries are cached in Supabase. Subsequent requests for the same filing URL return `"cached": true`.

## Authentication

All AI features (filing summarization, composite scoring, earnings sentiment, risk flags, activist analysis, recommendations, adversarial debate, memo export) are gated behind Supabase Auth. Users must sign in via email/password from the top-right of the page. The auth flow:

1. **Client-side** — `@supabase/ssr` browser client manages sessions via cookies. Sign-in/sign-up forms are inline in the page header.
2. **Server-side** — `/api/summarize` verifies the session cookie using `getAuthUser()` from `src/lib/auth.ts`. Unauthenticated requests get a `401`.
3. **OAuth callback** — `/auth/callback` handles the code exchange for email confirmation links.
4. **UI gating** — All AI buttons (▾ AI, 🔬, ✦ Summarize All, ✦ Compute Composite Score, ✦ Analyze Earnings Sentiment, ✦ Scan for Risk Flags, ✦ Analyze Activist Thesis, AI Recommendation, Red Team, Watch, Export Memo) are disabled and dimmed when not signed in.

To enable auth, you need `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in your environment. In the Supabase dashboard, enable Email auth under Authentication → Providers.

## Frontend AI Summary Integration

The company-centric UI (`src/app/page.tsx`) exposes the summarize API inline:

- **Paginated company list** — companies are displayed 20 per page with Previous/Next navigation controls at both the top and bottom of the list. Companies are sorted by most recent transaction date (descending), so the most recently active companies appear first.
- **Per-row buttons** — each transaction row has a `▾ AI` button (standard Haiku summary) and a `🔬` button (deep Sonnet analysis). Clicking opens an expandable panel below the row.
- **Deduplication** — multiple rows sharing the same accession number reuse the same cached result; only one fetch fires per unique URL.
- **Summary panel** — shows impact badge (color-coded: Positive=green, Negative=red, Mixed=yellow, Neutral=gray), summary text, flag list, parsed transactions sub-table, and a footer with model name, estimated cost, and `⚡ cached` indicator.
- **Deep analysis toggle** — the `🔬` button (or the "🔬 Deep Analysis" button inside an open panel) re-fetches with `deep_analysis=true` to use Claude Sonnet.
- **Summarize All** — each expanded company card shows a "✦ Summarize All" button that batch-fetches the most recent filing per insider (concurrency=3). Results aggregate into a company-level overview block at the top of the expanded section.
- **Persistent state** — summaries survive expand/collapse cycles, stored in a `Map<string, FilingSummary>` for the session.

## Libraries

### parseForm4 (`src/lib/parseForm4.ts`)

Fetches and parses SEC ownership XML (Forms 3, 4, 5) from EDGAR into structured insider transaction data:

- Officer name, title, transaction type (buy/sell/exercise)
- Shares traded, price per share, total dollar value
- Shares owned after transaction, transaction date
- Flags "notable" transactions (open-market buys > $100K)

### scoreSignal (`src/lib/scoreSignal.ts`)

Scores parsed Form 4 insider transactions on a 0–100 scale using five weighted signals:

| Signal | Weight | Description |
|---|---|---|
| Cluster buying | 25 | Multiple insiders buying within 30 days |
| Insider role | 20 | CEO/CFO purchases weighted higher than board members |
| Purchase type | 25 | Open-market purchases weighted higher than option exercises |
| Relative holdings | 15 | Buying >10% of existing holdings = strong conviction |
| Price dip | 15 | Buying near 52-week low (via Yahoo Finance) |

Returns the Insider Conviction Score (0–100), a plain-English rationale, raw breakdown, and attached fundamentals/short-interest data.

### compositeScore (`src/lib/compositeScore.ts`)

Wraps `scoreSignal()` to produce a four-component Composite Conviction Score (0–100):

| Component | Max pts | Method |
|---|---|---|
| Insider Conviction | 40 | ICS × 0.40 |
| Fundamentals | 25 | Revenue growth + gross margins + D/E bands |
| Valuation | 20 | Trailing P/E bands (8–15 = deep value = 20 pts) |
| Catalyst | 15 | Short float squeeze setup + activist filer bonus |

Generates a plain-English rationale naming the top 2–3 contributing factors.

### fundamentals (`src/lib/fundamentals.ts`)

Extended Yahoo Finance fundamentals fetcher. Retrieves `financialData` and `defaultKeyStatistics` modules from the Yahoo Finance v10 quoteSummary API, returning a `FundamentalsSnapshot` with 12 fields including `forwardPE`, `operatingMargins`, `totalDebt`, `returnOnEquity`, `shortPercentOfFloat`, and `shortRatio`. Results are cached in the `fundamentals_cache` Supabase table (JSONB) with a 24-hour TTL.

### parseAnnualFiling (`src/lib/parseAnnualFiling.ts`)

Ingests 10-Q and 10-K filings into Supabase. Calls `fetchAnnualFilings()` from `sec.ts` (last 4 quarterly + 2 annual filings), then upserts each result into the `annual_filings` table via conflict resolution on `(ticker, form_type, filing_date)`.

### costs (`src/lib/costs.ts`)

Estimates Anthropic API cost from input/output token counts and model name. Accounts for prompt caching discounts (90% off for cache reads, 25% surcharge for cache creation).

### anthropic (`src/lib/anthropic.ts`)

Shared singleton Anthropic client instance.

### supabase (`src/lib/supabase.ts`)

Shared singleton Supabase client instance.

## SEC fair-access compliance

- Requests are throttled via a token-bucket limiter to **10 req/sec per instance**
  (see [src/lib/sec.ts](src/lib/sec.ts)).
- Every outbound call sends a descriptive `User-Agent` header containing a
  contact email, sourced from the `SEC_USER_AGENT_EMAIL` environment variable.
- All code that calls sec.gov goes through `secFetch()` — never call `fetch` against `*.sec.gov` directly.

## Setup

```bash
npm install
cp .env.example .env.local   # then edit all values
npm run dev
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `SEC_USER_AGENT_EMAIL` | Yes | Contact email for SEC User-Agent header |
| `ANTHROPIC_API_KEY` | For /api/summarize | Anthropic API key |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL (used by both client and server) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon/public key (client-side auth) |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (server-side only) |
| `DATABASE_URL` | For migrations | Postgres connection string (Supabase Dashboard → Settings → Database) |

### Database migrations

Tables are managed via SQL migrations in the `migrations/` directory.

```bash
# Check migration status
npm run migrate:status

# Apply pending migrations
npm run migrate
```

Migrations require the `DATABASE_URL` env var.

### Supabase tables

The normalized schema has four tables (created by migration `001_normalized_schema.sql`):

```sql
-- Companies (issuers), keyed by SEC CIK
create table companies (
  cik text primary key,
  name text not null,
  ticker text,
  updated_at timestamptz not null default now()
);

-- Insiders (reporting owners), keyed by their SEC CIK
create table insiders (
  cik text primary key,
  name text not null,
  updated_at timestamptz not null default now()
);

-- Junction: which insiders belong to which companies
create table company_insiders (
  id bigint generated always as identity primary key,
  company_cik text not null references companies(cik),
  insider_cik text not null references insiders(cik),
  title text,
  relationship text,
  updated_at timestamptz not null default now(),
  unique (company_cik, insider_cik)
);

-- Individual transactions parsed from ownership filings
create table transactions (
  id bigint generated always as identity primary key,
  accession_no text not null,
  company_cik text not null references companies(cik),
  insider_cik text not null references insiders(cik),
  filing_type text not null,
  filing_url text not null,
  transaction_date text not null,
  transaction_type text not null,
  transaction_code text,
  shares numeric not null default 0,
  price_per_share numeric not null default 0,
  total_value numeric not null default 0,
  shares_owned_after numeric not null default 0,
  is_direct_ownership boolean default true,
  filed_at text not null,
  created_at timestamptz not null default now(),
  unique (accession_no, transaction_date, transaction_code, shares, insider_cik)
);
```

The `filing_summaries` table (for AI summarization caching) is unchanged.

Additional cache tables created by `migrations/006_fundamentals_cache.sql`, `migrations/007_annual_filings.sql`, `migrations/009_redesign_thirteen_dg_filings.sql`, and `migrations/010_ai_analysis_caches.sql`:

```sql
-- Yahoo Finance fundamentals (24h TTL)
create table fundamentals_cache (
  ticker     text primary key,
  data       jsonb not null,          -- FundamentalsSnapshot JSON
  fetched_at timestamptz not null default now()
);

-- 10-Q / 10-K MD&A excerpts
create table annual_filings (
  id               bigserial primary key,
  ticker           text not null,
  form_type        text not null,
  filing_date      date not null,
  period_of_report date,
  primary_doc_url  text,
  mda_excerpt      text not null default '',
  created_at       timestamptz not null default now(),
  unique (ticker, form_type, filing_date)
);

-- 13D / 13G activist filings
create table thirteen_dg_filings (
  id bigint generated always as identity primary key,
  accession_no           text not null unique,
  filer_name             text not null,
  subject_company_ticker text,
  filing_date            text not null,
  percent_of_class       numeric,
  item4_excerpt          text,
  ...
);

-- AI analysis cache tables (6h / 12h / 24h TTL enforced in app code)
create table composite_score_cache   (ticker text unique, total numeric, breakdown jsonb, ...);
create table earnings_sentiment_cache(ticker text unique, result jsonb, computed_at timestamptz);
create table activist_analysis_cache (ticker text unique, result jsonb, computed_at timestamptz);
create table risk_flag_cache         (ticker text unique, result jsonb, computed_at timestamptz);

-- Tier 3: AI recommendation cache (6h TTL)
create table recommendation_cache (
  id bigint generated always as identity primary key,
  ticker text not null unique,
  result jsonb not null,
  computed_at timestamptz not null default now()
);

-- Tier 3: Per-user watchlist with score-threshold alerts
create table watchlist (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  alert_threshold integer not null default 70 check (alert_threshold between 0 and 100),
  current_score integer,
  alert_triggered boolean not null default false,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, ticker)
);

-- Tier 3: Adversarial debate cache (12h TTL)
create table adversarial_cache (
  id bigint generated always as identity primary key,
  ticker text not null unique,
  result jsonb not null,
  computed_at timestamptz not null default now()
);
```

Open <http://localhost:3000>.

## Deploy

The project is configured for Vercel (see [vercel.json](vercel.json)).

**Option A — GitHub integration (recommended, no CLI):**
Push this repo to GitHub, then in the Vercel dashboard click
_Add New → Project_ and import the repo. Every push to `main` triggers a
production deploy and every PR gets a preview deploy. Set all environment
variables in Project Settings → Environment Variables.

**Option B — Vercel CLI:**
```bash
npx vercel           # first run: link project
npx vercel --prod    # deploy to production
```

## Project structure

```
src/
  app/
    api/
      companies/
        route.ts              # GET /api/companies
        [ticker]/route.ts     # GET /api/companies/[ticker]
      filings/
        route.ts              # GET /api/filings (EDGAR search)
        ingest/route.ts       # POST /api/filings/ingest
        annual/route.ts       # POST /api/filings/annual (10-Q/10-K ingest)
      signal/
        composite/route.ts    # GET /api/signal/composite
        recommendation/route.ts # GET /api/signal/recommendation
      analyze/
        adversarial/route.ts  # GET /api/analyze/adversarial
        activist/route.ts     # GET /api/analyze/activist
        earnings-sentiment/route.ts  # GET /api/analyze/earnings-sentiment
        risk-flags/route.ts   # GET /api/analyze/risk-flags
      summarize/route.ts      # GET /api/summarize
      watchlist/route.ts      # GET/POST/DELETE/PATCH /api/watchlist
      watchlist/refresh/route.ts # POST /api/watchlist/refresh
      export/memo/route.ts    # POST /api/export/memo
    company/[ticker]/page.tsx # company detail page (client component)
    watchlist/page.tsx        # watchlist management page
    layout.tsx
    page.tsx                  # company-centric insider tracking UI
  lib/
    anthropic.ts              # shared Anthropic client
    auth.ts                   # server-side auth verification helper
    compositeScore.ts         # composite conviction scorer (4 components)
    costs.ts                  # token cost estimator
    fundamentals.ts           # extended Yahoo Finance fundamentals fetcher
    ingestJobs.ts             # in-memory background job store
    marketData.ts             # short interest fetcher (Yahoo Finance)
    parse13DG.ts              # 13D/G filing parser
    parse13F.ts               # 13F holdings parser
    parse8K.ts                # 8-K filing parser
    parseAnnualFiling.ts      # 10-Q/10-K ingest → annual_filings table
    parseForm4.ts             # ownership XML parser (Forms 3/4/5)
    scoreSignal.ts            # insider transaction scoring engine (ICS 0–100)
    sec.ts                    # rate-limited EDGAR fetch + search + annual filings
    supabase.ts               # shared Supabase client (service role)
    supabase-browser.ts       # browser Supabase client (anon key)
    assembleSignalContext.ts   # shared signal context builder for AI features
    generateMemoContent.ts    # memo section generator via Claude Sonnet
    types.ts                  # shared TypeScript type definitions
scripts/
  migrate.ts                  # database migration runner
migrations/
  001_normalized_schema.sql   # companies, insiders, transactions tables
  002_8k_and_13f.sql
  003_fix_13f_unique_constraint.sql
  004_add_issuer_name_to_summaries.sql
  005_add_summary_detail_columns.sql
  006_fundamentals_cache.sql  # fundamentals_cache table
  007_annual_filings.sql      # annual_filings table
  008_thirteen_dg_filings.sql # initial thirteen_dg_filings table
  009_redesign_thirteen_dg_filings.sql  # schema redesign
  010_ai_analysis_caches.sql  # composite_score_cache, earnings_sentiment_cache,
                              # activist_analysis_cache, risk_flag_cache
  011_recommendation_cache.sql # recommendation_cache table
  012_watchlist.sql            # watchlist table with RLS
  013_adversarial_cache.sql    # adversarial_cache table
```
