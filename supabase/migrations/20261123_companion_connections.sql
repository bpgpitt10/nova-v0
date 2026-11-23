-- Has a Looper Companion ever answered for this account, and has it ever seen
-- GSPro? One row per account, written by the site when the companion answers.
-- Without it, "never installed the companion" and "installed it but never hit
-- a shot" look the same (23 Nov: 15 confirmed accounts with no shots).
create table if not exists public.companion_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- First time the companion reported GSPro itself connected; null until then.
  gspro_seen_at timestamptz,
  release text,
  updated_at timestamptz not null default now()
);

alter table public.companion_connections enable row level security;

drop policy if exists "users own companion connections" on public.companion_connections;
create policy "users own companion connections" on public.companion_connections
  for all
  using ((user_id = (select auth.uid())) and private.is_allowed_user())
  with check ((user_id = (select auth.uid())) and private.is_allowed_user());
