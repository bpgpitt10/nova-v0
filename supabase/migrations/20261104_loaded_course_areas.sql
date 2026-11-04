-- Courses loaded as a whole map area (course-area-v1.json) instead of hole by
-- hole: OpenStreetMap had the course's fairways, greens and bunkers but not
-- one numbered hole line per hole (partly drawn courses, resorts with several
-- courses in one outline). GSPro's own course file supplies the holes on the
-- player's PC. A separate table so apps that only know hole packages never
-- list these. Same storage bucket and read rule as loaded_courses.

create table if not exists public.loaded_course_areas (
  slug text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  course_id text not null unique check (char_length(course_id) between 3 and 160),
  name text not null check (char_length(name) between 1 and 160),
  location text not null default '' check (char_length(location) <= 160),
  gspro_aliases text[] not null default '{}',
  package_url text not null check (package_url ~ '^https://'),
  lidar boolean not null default false,
  greens integer,
  osm_type text check (osm_type is null or osm_type in ('way', 'relation')),
  osm_id bigint,
  request_id uuid,
  published_at timestamptz not null default now()
);

alter table public.loaded_course_areas enable row level security;

create policy "looper users read loaded course areas"
  on public.loaded_course_areas for select to authenticated
  using (private.is_allowed_user());

-- Writes: the loader's service-role key only (no insert/update policies).
