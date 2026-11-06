-- Course crosswalk: every public GSPro course (Simulator Golf Tour's course
-- manifest, which GSPro's course downloads come from: id, name, GSPro course
-- folder = the key GSPro reports, location, coordinates, altitude) matched
-- once to the real course on OpenStreetMap. Loading a course reads this first and loads exactly that OSM
-- course: no name search, no place lookup (11/4: "Panorama, BC" geocoded to
-- Vancouver and loaded Point Grey as Greywolf).
--
-- status
--   matched     one clear OSM course near the course's coordinates
--   review      close call (two candidates, a weak or missing OSM name)
--   no-map      no golf course mapped near the coordinates
--   fictional   no real location (Middle Earth GC)
-- verified: a player's course match (GSPro's greens on the map) confirmed it.

create table if not exists public.course_crosswalk (
  sgt_id integer primary key,
  name text not null check (char_length(name) between 1 and 200),
  location text not null default '',
  par integer,
  designer text,
  lat double precision,
  lon double precision,
  country text,
  elevation_ft integer,
  sgt_updated date,
  gspro_folder text,
  gspro_keys text[] not null default '{}',
  status text not null check (status in ('matched', 'review', 'no-map', 'fictional')),
  osm_type text check (osm_type is null or osm_type in ('way', 'relation')),
  osm_id bigint,
  osm_name text,
  distance_m integer,
  name_score real,
  candidates jsonb not null default '[]',
  method text not null default 'auto' check (method in ('auto', 'manual', 'greens')),
  verified boolean not null default false,
  notes text,
  updated_at timestamptz not null default now()
);

create index if not exists course_crosswalk_gspro_keys on public.course_crosswalk using gin (gspro_keys);
create index if not exists course_crosswalk_name on public.course_crosswalk (lower(name));
create index if not exists course_crosswalk_folder on public.course_crosswalk (lower(gspro_folder));

alter table public.course_crosswalk enable row level security;

create policy "looper users read the course crosswalk"
  on public.course_crosswalk for select to authenticated
  using (private.is_allowed_user());

-- Writes: the crosswalk builder's service-role key only (no insert/update policies).
