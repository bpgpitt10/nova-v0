-- Follow-up hardening for Looper auth helpers.
-- Keeps SECURITY DEFINER helpers out of the exposed public API schema.

create schema if not exists extensions;
alter extension citext set schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.is_allowed_user()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.allowed_users au
    where au.enabled = true
      and lower(au.email::text) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function private.is_allowed_user() from public;
revoke all on function private.is_allowed_user() from anon;
grant execute on function private.is_allowed_user() to authenticated;

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  )
  on conflict (id) do update
    set email = excluded.email,
        display_name = coalesce(excluded.display_name, public.profiles.display_name),
        updated_at = now();
  return new;
end;
$$;

revoke all on function private.handle_new_auth_user() from public;
revoke all on function private.handle_new_auth_user() from anon;
revoke all on function private.handle_new_auth_user() from authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute procedure private.handle_new_auth_user();

drop policy if exists "users can read own profile" on public.profiles;
drop policy if exists "users can update own profile" on public.profiles;
drop policy if exists "users own bags" on public.bags;
drop policy if exists "users own sessions" on public.sessions;
drop policy if exists "users own shots" on public.shots;
drop policy if exists "users own diagnostic events" on public.diagnostic_events;

create policy "users can read own profile"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() and private.is_allowed_user());

create policy "users can update own profile"
  on public.profiles for update
  to authenticated
  using (id = auth.uid() and private.is_allowed_user())
  with check (id = auth.uid() and private.is_allowed_user());

create policy "users own bags"
  on public.bags for all
  to authenticated
  using (user_id = auth.uid() and private.is_allowed_user())
  with check (user_id = auth.uid() and private.is_allowed_user());

create policy "users own sessions"
  on public.sessions for all
  to authenticated
  using (user_id = auth.uid() and private.is_allowed_user())
  with check (user_id = auth.uid() and private.is_allowed_user());

create policy "users own shots"
  on public.shots for all
  to authenticated
  using (user_id = auth.uid() and private.is_allowed_user())
  with check (user_id = auth.uid() and private.is_allowed_user());

create policy "users own diagnostic events"
  on public.diagnostic_events for all
  to authenticated
  using (user_id = auth.uid() and private.is_allowed_user())
  with check (user_id = auth.uid() and private.is_allowed_user());

drop function if exists public.handle_new_auth_user();
drop function if exists public.is_allowed_user();
