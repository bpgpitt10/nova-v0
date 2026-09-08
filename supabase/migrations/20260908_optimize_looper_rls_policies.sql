-- Supabase advisor follow-up: evaluate auth helpers once per statement and index diagnostic session lookups.

create index if not exists diagnostic_events_session_idx
  on public.diagnostic_events(session_id);

drop policy if exists "allowed users can read own allowlist row" on public.allowed_users;
create policy "allowed users can read own allowlist row"
  on public.allowed_users for select
  to authenticated
  using (
    enabled = true
    and lower(email::text) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  );

drop policy if exists "users can read own profile" on public.profiles;
create policy "users can read own profile"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()) and private.is_allowed_user());

drop policy if exists "users can update own profile" on public.profiles;
create policy "users can update own profile"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()) and private.is_allowed_user())
  with check (id = (select auth.uid()) and private.is_allowed_user());

drop policy if exists "users own bags" on public.bags;
create policy "users own bags"
  on public.bags for all
  to authenticated
  using (user_id = (select auth.uid()) and private.is_allowed_user())
  with check (user_id = (select auth.uid()) and private.is_allowed_user());

drop policy if exists "users own sessions" on public.sessions;
create policy "users own sessions"
  on public.sessions for all
  to authenticated
  using (user_id = (select auth.uid()) and private.is_allowed_user())
  with check (user_id = (select auth.uid()) and private.is_allowed_user());

drop policy if exists "users own shots" on public.shots;
create policy "users own shots"
  on public.shots for all
  to authenticated
  using (user_id = (select auth.uid()) and private.is_allowed_user())
  with check (user_id = (select auth.uid()) and private.is_allowed_user());

drop policy if exists "users own diagnostic events" on public.diagnostic_events;
create policy "users own diagnostic events"
  on public.diagnostic_events for all
  to authenticated
  using (user_id = (select auth.uid()) and private.is_allowed_user())
  with check (user_id = (select auth.uid()) and private.is_allowed_user());
