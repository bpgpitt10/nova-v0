-- Enable self-service Looper account creation without removing the existing
-- per-user RLS model or admin disable controls.
--
-- New auth users receive a normal enabled allowed_users row automatically.
-- Existing rows are never overwritten, so admins stay admins and disabled users
-- stay disabled. Existing auth users who never received an allowlist row are
-- backfilled once so they can use the now-open signup model too.

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.email is not null then
    insert into public.allowed_users (email, enabled, is_admin, display_name)
    values (
      new.email,
      true,
      false,
      coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
    )
    on conflict (email) do nothing;
  end if;

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

insert into public.allowed_users (email, enabled, is_admin, display_name)
select
  users.email,
  true,
  false,
  coalesce(users.raw_user_meta_data ->> 'full_name', users.raw_user_meta_data ->> 'name')
from auth.users as users
where users.email is not null
on conflict (email) do nothing;
