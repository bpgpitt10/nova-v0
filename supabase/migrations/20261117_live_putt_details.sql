-- Every putt, whole: GSPro's roll path and every plain field it wrote for the
-- shot (aimed direction, start direction, cup point, speed, holed/gimme).
-- One row per putt, owned by the player. The summary stays in
-- live_course_shots; this is the raw material for putting analysis.
create table if not exists public.live_putt_details (
  user_id uuid not null references auth.users (id) on delete cascade,
  gspro_round_id bigint not null,
  shot_id text not null,
  course_key text,
  hole_number integer,
  hole_shot integer,
  global_shot_number integer,
  detail jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, gspro_round_id, shot_id)
);

alter table public.live_putt_details enable row level security;

drop policy if exists "users own live putt details" on public.live_putt_details;
create policy "users own live putt details" on public.live_putt_details
  for all
  using ((user_id = (select auth.uid())) and private.is_allowed_user())
  with check ((user_id = (select auth.uid())) and private.is_allowed_user());
