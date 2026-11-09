-- Confirmed tee and pin positions, one row per course, hole, tee set and pin
-- day, written when GSPro's own shot evidence confirms both (the ball's
-- StartingPOS on a GKD tee, GSPro's DistanceToPin matching a GKD pin). The
-- course file on each player's PC is the first source; these rows are the
-- fallback for players whose file Looper can't read, and a cross-check.
-- The first round anyone plays a course with a tee and day fills it in for
-- everyone after (Brian, 11/9). Shared across accounts; positions only.
create table if not exists public.confirmed_positions (
  course_id text not null,
  course_key text not null,
  hole_number integer not null check (hole_number between 1 and 18),
  tee_set text not null default '',
  pin_day text not null default '',
  layout_fingerprint text not null,
  tee_name text,
  tee_world jsonb not null,
  pin_slot integer not null,
  pin_label text,
  pin_world jsonb not null,
  confirmations integer not null default 1,
  confirmed_by uuid references auth.users (id) on delete set null,
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (course_id, hole_number, tee_set, pin_day)
);

alter table public.confirmed_positions enable row level security;

drop policy if exists "allowed users share confirmed positions" on public.confirmed_positions;
create policy "allowed users share confirmed positions" on public.confirmed_positions
  for all
  using (private.is_allowed_user())
  with check (private.is_allowed_user());
