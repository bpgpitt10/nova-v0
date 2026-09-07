-- Only enabled users may see their own allow-list row.

drop policy if exists "allowed users can read own allowlist row" on public.allowed_users;

create policy "allowed users can read own allowlist row"
  on public.allowed_users for select
  to authenticated
  using (
    enabled = true
    and lower(email::text) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
