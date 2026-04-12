create table if not exists adversarial_cache (
  id bigint generated always as identity primary key,
  ticker text not null unique,
  result jsonb not null,
  computed_at timestamptz not null default now()
);
