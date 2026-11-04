-- Links between a GSPro course (its CourseKey, e.g. "dpc_pebble_gsp") and a
-- course loaded into Looper (its slug, e.g. "pebble-beach"), for GSPro
-- courses whose name doesn't match the map name. Set from the Load page by any
-- Looper user; read by everyone's app at start. Course names only.

create table if not exists public.course_gspro_links (
  gspro_course_key text primary key check (char_length(gspro_course_key) between 2 and 120),
  gspro_course_name text check (gspro_course_name is null or char_length(gspro_course_name) <= 120),
  course_slug text not null check (course_slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  linked_by uuid default auth.uid() references auth.users (id) on delete set null,
  linked_at timestamptz not null default now()
);

alter table public.course_gspro_links enable row level security;

create policy "looper users read gspro links"
  on public.course_gspro_links for select to authenticated
  using (private.is_allowed_user());

create policy "looper users add gspro links"
  on public.course_gspro_links for insert to authenticated
  with check (private.is_allowed_user() and linked_by = auth.uid());

create policy "looper users change gspro links"
  on public.course_gspro_links for update to authenticated
  using (private.is_allowed_user())
  with check (private.is_allowed_user());

create policy "looper users remove gspro links"
  on public.course_gspro_links for delete to authenticated
  using (private.is_allowed_user());
