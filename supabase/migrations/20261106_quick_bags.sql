-- Quick Bag: a player's starting club numbers from a handicap and three carries
-- (Driver, 7i, PW, each with a draw / neutral / fade shape), plus any carries
-- they typed over the gapped guesses. One row per account; the browser keeps a
-- per-user copy for the Live Caddie workers. Range shots blend it out per club.
create table if not exists public.quick_bags (
  user_id uuid primary key references auth.users (id) on delete cascade,
  handicap double precision,
  anchors jsonb not null,
  clubs text[] not null default '{}',
  carry_overrides jsonb not null default '{}'::jsonb,
  handed text not null default 'right' check (handed in ('right', 'left')),
  saved_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.quick_bags enable row level security;

drop policy if exists "users own quick bags" on public.quick_bags;
create policy "users own quick bags" on public.quick_bags
  for all
  using (user_id = (select auth.uid()) and private.is_allowed_user())
  with check (user_id = (select auth.uid()) and private.is_allowed_user());

-- Caddie vs you: what the recommendation's club numbers rested on when it was
-- made: 'starting-bag' (no range shots for the club), 'learning' (a blend) or
-- 'measured'. Long-term caddie-vs-you totals count measured decisions only.
alter table public.live_course_shots
  add column if not exists model_basis text
  check (model_basis in ('starting-bag', 'learning', 'measured'));
