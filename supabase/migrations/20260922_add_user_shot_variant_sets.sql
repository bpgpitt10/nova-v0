create table if not exists public.shot_variant_sets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  variants jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shot_variant_sets_variants_array check (jsonb_typeof(variants) = 'array')
);

alter table public.shot_variant_sets enable row level security;

drop policy if exists "users own shot variant sets" on public.shot_variant_sets;
create policy "users own shot variant sets"
on public.shot_variant_sets
for all
using (
  user_id = (select auth.uid())
  and private.is_allowed_user()
)
with check (
  user_id = (select auth.uid())
  and private.is_allowed_user()
);

revoke all on table public.shot_variant_sets from anon;
grant select, insert, update, delete on table public.shot_variant_sets to authenticated;
grant all on table public.shot_variant_sets to service_role;
