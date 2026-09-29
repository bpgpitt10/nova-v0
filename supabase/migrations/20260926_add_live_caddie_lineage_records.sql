-- Durable, append-only lineage for Live Caddie decisions and physical GSPro shots.
-- The physical shot payload remains authoritative in live_course_shots; these
-- records preserve the recommendation -> arm/spec -> attempt -> next-state chain.

create table if not exists public.live_caddie_lineage_records (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  lineage_round_id uuid not null,
  record_type text not null,
  created_at timestamptz not null,
  supersedes_id uuid,
  state_id uuid,
  decision_id uuid,
  shot_spec_id uuid,
  attempt_id uuid,
  outcome_id uuid,
  gspro_round_id bigint,
  gspro_shot_id text,
  payload jsonb not null default '{}'::jsonb,
  constraint live_caddie_lineage_record_type_check check (
    record_type in ('round', 'state', 'decision', 'shot_spec', 'shot_attempt', 'shot_outcome')
  )
);

create index if not exists live_caddie_lineage_user_round_idx
  on public.live_caddie_lineage_records(user_id, lineage_round_id, created_at);

create index if not exists live_caddie_lineage_gspro_shot_idx
  on public.live_caddie_lineage_records(user_id, gspro_round_id, gspro_shot_id)
  where gspro_round_id is not null and gspro_shot_id is not null;

create unique index if not exists live_caddie_lineage_attempt_gspro_shot_unique
  on public.live_caddie_lineage_records(user_id, gspro_round_id, gspro_shot_id)
  where record_type = 'shot_attempt'
    and gspro_round_id is not null
    and gspro_shot_id is not null;

alter table public.live_caddie_lineage_records enable row level security;

drop policy if exists "users own live caddie lineage records"
  on public.live_caddie_lineage_records;

create policy "users own live caddie lineage records"
  on public.live_caddie_lineage_records for all
  to authenticated
  using (
    user_id = (select auth.uid())
    and private.is_allowed_user()
  )
  with check (
    user_id = (select auth.uid())
    and private.is_allowed_user()
  );

comment on table public.live_caddie_lineage_records is
  'Append-only Live Caddie lineage: round/state/decision/spec/attempt/outcome records. No screenshots or image payloads.';