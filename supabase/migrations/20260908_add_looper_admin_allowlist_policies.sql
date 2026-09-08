-- Allow Looper admins to manage the invite list without a service-role key.

create or replace function private.is_admin_user()
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
      and au.is_admin = true
      and lower(au.email::text) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  );
$$;

revoke all on function private.is_admin_user() from public;
revoke all on function private.is_admin_user() from anon;
grant execute on function private.is_admin_user() to authenticated;

create policy "admins can read allowlist"
  on public.allowed_users for select
  to authenticated
  using (private.is_admin_user());

create policy "admins can insert allowlist"
  on public.allowed_users for insert
  to authenticated
  with check (private.is_admin_user());

create policy "admins can update allowlist"
  on public.allowed_users for update
  to authenticated
  using (private.is_admin_user())
  with check (private.is_admin_user());

create policy "admins can delete allowlist"
  on public.allowed_users for delete
  to authenticated
  using (private.is_admin_user());
