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

**Requires authentication.** Returns a single company by ticker symbol with its insiders, transactions, 8-K events, 13F holdings, and cached AI summaries. Returns `404` if the ticker is not found.

```
GET /api/companies/AAPL
```

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

AI features (summarization) are gated behind Supabase Auth. Users must sign in via email/password from the top-right of the page. The auth flow:

1. **Client-side** — `@supabase/ssr` browser client manages sessions via cookies. Sign-in/sign-up forms are inline in the page header.
2. **Server-side** — `/api/summarize` verifies the session cookie using `getAuthUser()` from `src/lib/auth.ts`. Unauthenticated requests get a `401`.
3. **OAuth callback** — `/auth/callback` handles the code exchange for email confirmation links.
4. **UI gating** — AI buttons (▾ AI, 🔬, ✦ Summarize All) are disabled and dimmed when not signed in.

To enable auth, you need `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in your environment. In the Supabase dashboard, enable Email auth under Authentication → Providers.

## Frontend AI Summary Integration

The company-centric UI (`src/app/page.tsx`) exposes the summarize API inline:

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

Returns the score, a plain-English rationale, and raw signal breakdown.

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

The `filing_summaries` table (for AI summarization caching) remains unchanged:

```sql
create table filing_summaries (
  id bigint generated always as identity primary key,
  filing_url text not null,
  deep_analysis boolean not null default false,
  summary text not null,
  impact_rating text not null,
  flags jsonb default '[]',
  model_used text not null,
  estimated_cost numeric not null,
  created_at timestamptz not null default now(),
  unique (filing_url, deep_analysis)
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
      companies/route.ts     # GET /api/companies
      filings/
        route.ts             # GET /api/filings (EDGAR search)
        ingest/route.ts      # POST /api/filings/ingest
      summarize/route.ts     # GET /api/summarize
    layout.tsx
    page.tsx                 # company-centric insider tracking UI
  lib/
    anthropic.ts             # shared Anthropic client
    auth.ts                  # server-side auth verification helper
    costs.ts                 # token cost estimator
    parseForm4.ts            # ownership XML parser (Forms 3/4/5)
    scoreSignal.ts           # insider transaction scoring engine
    sec.ts                   # rate-limited EDGAR fetch + search
    supabase.ts              # shared Supabase client (service role)
    supabase-browser.ts      # browser Supabase client (anon key)
    types.ts                 # shared TypeScript type definitions
scripts/
  migrate.ts                 # database migration runner
migrations/
  001_normalized_schema.sql  # companies, insiders, transactions tables
```
