-- "Test your read": the 20 closest reads, with up to three initials each.
-- Anyone may post one; the site reads only the top 20 through the view.
-- The score is the straight line, in yards, from the read to where the ball
-- finished. It is checked against the read itself, and the shot has to have
-- moved at least 5 yards from the club's normal, so an easy shot can't win.

create table if not exists public.insight_read_leaderboard (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  initials text not null check (initials ~ '^[A-Z]{1,3}$' and initials !~ '^(ASS|FUK|FUC|FCK|KKK|NIG|FAG|CUM|TIT|DIK|COK)$'),
  miss_yds numeric(5,1) not null check (miss_yds between 0 and 60),
  club text not null check (char_length(club) between 1 and 40),
  base_yds numeric not null check (base_yds between 40 and 320),
  actual_yds numeric not null check (actual_yds between 10 and 380),
  actual_side_yds numeric not null check (actual_side_yds between -90 and 90),
  guess_yds numeric not null check (guess_yds between 10 and 380),
  guess_side_yds numeric not null check (guess_side_yds between -90 and 90),
  constraint miss_matches_the_read check (abs(miss_yds - sqrt(power(actual_yds - guess_yds, 2) + power(actual_side_yds - guess_side_yds, 2))) <= 0.11),
  constraint shot_moved_from_normal check (sqrt(power(actual_yds - base_yds, 2) + power(actual_side_yds, 2)) >= 5)
);

alter table public.insight_read_leaderboard enable row level security;

drop policy if exists "anyone can post a read" on public.insight_read_leaderboard;
create policy "anyone can post a read" on public.insight_read_leaderboard
  for insert to anon, authenticated with check (true);

revoke all on public.insight_read_leaderboard from anon, authenticated;
grant insert on public.insight_read_leaderboard to anon, authenticated;

create or replace view public.insight_read_top20 as
select initials, miss_yds, club, created_at::date as read_on
from public.insight_read_leaderboard
order by miss_yds asc, created_at asc
limit 20;

revoke all on public.insight_read_top20 from anon, authenticated;
grant select on public.insight_read_top20 to anon, authenticated;
