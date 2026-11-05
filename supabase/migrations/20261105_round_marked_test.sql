-- A player can mark a round as a test (Live Caddie checks, conceded holes, keyboard shots).
-- Rounds then treat it as a test round: out of the Full rounds list, Your game and the
-- landing averages. Additive; the round archiver's upsert doesn't send this column.
alter table public.live_course_rounds
  add column if not exists marked_test boolean not null default false;
