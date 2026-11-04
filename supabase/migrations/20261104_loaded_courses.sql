-- Courses loaded by the one-click loader, published at run time instead of
-- committed into the site's code (a load used to commit to the production
-- branch and wait for a Vercel deploy). The worker uploads the course's
-- package files to the public `course-packages` storage bucket and writes one
-- row here; every Looper app reads the rows at start and adds the courses to
-- its catalog. Package files are built from open map and elevation data.

create table if not exists public.loaded_courses (
  slug text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  course_id text not null unique check (char_length(course_id) between 3 and 160),
  name text not null check (char_length(name) between 1 and 160),
  location text not null default '' check (char_length(location) <= 160),
  gspro_aliases text[] not null default '{}',
  package_url text not null check (package_url ~ '^https://'),
  lidar boolean not null default false,
  hole_headings jsonb,
  osm_type text check (osm_type is null or osm_type in ('way', 'relation')),
  osm_id bigint,
  request_id uuid,
  published_at timestamptz not null default now()
);

alter table public.loaded_courses enable row level security;

create policy "looper users read loaded courses"
  on public.loaded_courses for select to authenticated
  using (private.is_allowed_user());

-- Writes: the loader's service-role key only (no insert/update policies).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('course-packages', 'course-packages', true, 52428800, array['application/json'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
