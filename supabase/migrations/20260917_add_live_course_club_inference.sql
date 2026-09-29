alter table public.live_course_shots
  add column if not exists attributed_at timestamptz,
  add column if not exists inferred_club text,
  add column if not exists inference_confidence double precision,
  add column if not exists inference_alternatives jsonb not null default '[]'::jsonb,
  add column if not exists inference_model_version text,
  add column if not exists inference_evaluated_at timestamptz;

comment on column public.live_course_shots.actual_club is
  'Authoritative club attribution when known; manual/user-confirmed is ground truth.';

comment on column public.live_course_shots.inferred_club is
  'Shadow-only club prediction; does not drive analysis unless separately promoted.';

comment on column public.live_course_shots.inference_confidence is
  'Normalized confidence from the stored inference model.';
