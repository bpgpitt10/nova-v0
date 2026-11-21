-- "Test your read" on the public insights page: each guess a visitor checks,
-- so the page can say how far off people are on average.
-- Nothing about the visitor is stored. Anyone may add a row; nobody can read
-- the rows through the API, only the totals in insight_read_stats.

create table if not exists public.insight_read_guesses (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  club text not null check (char_length(club) between 1 and 40),
  base_yds numeric not null check (base_yds between 40 and 320),
  actual_yds numeric not null check (actual_yds between 10 and 380),
  actual_side_yds numeric not null check (actual_side_yds between -90 and 90),
  guess_yds numeric not null check (guess_yds between 10 and 380),
  guess_side_yds numeric not null check (guess_side_yds between -90 and 90),
  conditions jsonb not null check (jsonb_typeof(conditions) = 'object' and pg_column_size(conditions) < 1500)
);

alter table public.insight_read_guesses enable row level security;

drop policy if exists "anyone can add a read" on public.insight_read_guesses;
create policy "anyone can add a read" on public.insight_read_guesses
  for insert to anon, authenticated with check (true);

revoke all on public.insight_read_guesses from anon, authenticated;
grant insert on public.insight_read_guesses to anon, authenticated;

-- Totals only. The view reads the table as its owner, so it works without a
-- select policy on the rows themselves.
create or replace view public.insight_read_stats as
select
  count(*)::int as reads,
  round(avg(abs(actual_yds - guess_yds)), 1) as avg_miss_yds,
  round(avg(abs(actual_yds - guess_yds) / actual_yds) * 100, 1) as avg_miss_pct,
  round(avg(abs(actual_side_yds - guess_side_yds)), 1) as avg_side_miss_yds
from public.insight_read_guesses;

revoke all on public.insight_read_stats from anon, authenticated;
grant select on public.insight_read_stats to anon, authenticated;
