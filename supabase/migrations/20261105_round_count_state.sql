-- Whether a round counts toward the player's stats, chosen on the Rounds page.
--   counts    in every stat
--   excluded  kept in the history, left out of every stat
--   deleted   tombstone: the round's shots are removed, and syncing from the sim PC
--             (companion backlog, live archiver) skips the round so it doesn't come back
--   null      Looper decides: rounds that look like tests don't count until the player says so
-- The round archiver's upsert doesn't send this column, so syncing never changes it.
alter table public.live_course_rounds
  add column if not exists count_state text
  check (count_state in ('counts', 'excluded', 'deleted'));

comment on column public.live_course_rounds.count_state is
  'Player''s choice: counts | excluded (kept, out of stats) | deleted (tombstone: shots removed, re-ingest skips it). Null: Looper decides (rounds that look like tests do not count).';
