create table if not exists recommendation_cache (
  id bigint generated always as identity primary key,
  ticker text not null unique,
  result jsonb not null,
  computed_at timestamptz not null default now()
);

create index if not exists idx_recommendation_cache_ticker on recommendation_cache(ticker);
