# Investment Seeker

A Next.js (App Router) application for monitoring SEC insider trading activity with AI-powered analysis.

## API Endpoints

### GET /api/filings

Search recent SEC filings from the EDGAR full-text search index.

```
GET /api/filings?type=<4|8-K|13F>&ticker=<TICKER>&limit=<1-100>
```

- `type` (required) — filing form. Accepted aliases: `4`, `form4`, `8-K`, `8k`, `13F`, `13F-HR`, `13F-NT`.
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

### GET /api/summarize

AI-powered filing summarizer using the Anthropic API with a two-tier model strategy.

```
GET /api/summarize?url=<SEC_FILING_URL>&deep_analysis=<true|false>
```

- `url` (required) — URL to an SEC filing on sec.gov.
- `deep_analysis` (optional) — `true` to use Claude Sonnet for deeper analysis (mergers, restatements). Defaults to Haiku.

#### Response

```json
{
  "summary": "...",
  "impactRating": "Positive",
  "flags": ["Notable insider buying activity"],
  "modelUsed": "claude-haiku-4-5-20251001",
  "estimatedCost": 0.000342,
  "cached": false
}
```

Summaries are cached in Supabase. Subsequent requests for the same filing URL return `"cached": true`.

## Libraries

### parseForm4 (`src/lib/parseForm4.ts`)

Fetches and parses Form 4 XML from EDGAR into structured insider transaction data:

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
| `SUPABASE_URL` | For /api/summarize | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | For /api/summarize | Supabase service role key |

### Supabase table

The `/api/summarize` endpoint requires a `filing_summaries` table:

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
      filings/route.ts     # GET /api/filings
      summarize/route.ts   # GET /api/summarize
    layout.tsx
    page.tsx               # homepage with usage examples
  lib/
    anthropic.ts           # shared Anthropic client
    costs.ts               # token cost estimator
    parseForm4.ts          # Form 4 XML parser
    scoreSignal.ts         # insider transaction scoring engine
    sec.ts                 # rate-limited EDGAR fetch + search
    supabase.ts            # shared Supabase client
    types.ts               # shared TypeScript type definitions
```
