-- Caddie vs you: the engine's expected strokes at arm time, per armed shot.
-- armed - recommended; positive means the engine expected its own pick to do
-- better. Null for shots armed before 6 Nov 2026 or when the engine had no value.
alter table public.live_course_shots
  add column if not exists armed_expected_strokes double precision,
  add column if not exists recommended_expected_strokes double precision,
  add column if not exists paper_cost_strokes double precision;
