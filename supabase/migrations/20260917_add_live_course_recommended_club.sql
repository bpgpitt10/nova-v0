alter table public.live_course_shots
  add column if not exists recommended_club text;

comment on column public.live_course_shots.recommended_club is
  'Looper recommended club at the moment the user armed the physical shot.';
