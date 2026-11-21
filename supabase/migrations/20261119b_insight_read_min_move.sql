-- The quiz now only deals shots that move at least 5 yards from normal, so
-- every first read can count for the board.
alter table public.insight_read_leaderboard drop constraint if exists shot_moved_from_normal;
alter table public.insight_read_leaderboard add constraint shot_moved_from_normal
  check (sqrt(power(actual_yds - base_yds, 2) + power(actual_side_yds, 2)) >= 5);
