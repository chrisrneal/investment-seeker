create table if not exists watchlist (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  company_name text not null default '',
  alert_threshold integer not null default 70
    check (alert_threshold >= 0 and alert_threshold <= 100),
  current_score numeric,
  alert_triggered boolean not null default false,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, ticker)
);

create index if not exists idx_watchlist_user_id on watchlist(user_id);
create index if not exists idx_watchlist_ticker on watchlist(ticker);

alter table watchlist enable row level security;

create policy "users can manage their own watchlist"
  on watchlist for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
 