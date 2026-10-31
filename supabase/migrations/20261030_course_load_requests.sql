-- One-click course loading: the queue a signed-in player adds to with "Load",
-- worked by the GitHub Actions course loader (service role), and read back by
-- the Load page for progress. Contains course names/locations only; no GSPro
-- files or player data beyond who asked.

create table if not exists public.course_load_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  requested_by uuid default auth.uid() references auth.users (id) on delete set null,
  course_name text not null check (char_length(course_name) between 2 and 120),
  location text check (location is null or char_length(location) <= 120),
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  osm_type text check (osm_type in ('way', 'relation')),
  osm_id bigint,
  gspro_course_key text check (gspro_course_key is null or char_length(gspro_course_key) <= 120),
  slug text check (slug is null or slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  status text not null default 'queued' check (status in ('queued', 'running', 'publishing', 'ready', 'failed')),
  stage text,
  stage_index integer,
  stage_count integer,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  report jsonb
);

create index if not exists course_load_requests_status_created
  on public.course_load_requests (status, created_at);

-- One live request per course.
create unique index if not exists course_load_requests_one_active_per_slug
  on public.course_load_requests (slug)
  where status in ('queued', 'running', 'publishing') and slug is not null;

alter table public.course_load_requests enable row level security;

-- Any enabled Looper user can see loads (a course loaded once is for everyone).
create policy "looper users read course loads"
  on public.course_load_requests
  for select
  to authenticated
  using (private.is_allowed_user());

-- Players can only queue a new request as themselves; progress, results and
-- errors are written by the loader (service role bypasses RLS).
create policy "looper users queue course loads"
  on public.course_load_requests
  for insert
  to authenticated
  with check (
    private.is_allowed_user()
    and requested_by = auth.uid()
    and status = 'queued'
    and stage is null and started_at is null and finished_at is null
    and error is null and report is null
  );

-- At most 5 queued requests per player at a time.
create or replace function private.limit_course_load_requests()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.course_load_requests
      where requested_by = new.requested_by and status in ('queued', 'running', 'publishing')) >= 5 then
    raise exception 'Too many course loads in progress; wait for one to finish.';
  end if;
  return new;
end;
$$;

revoke all on function private.limit_course_load_requests() from public;

drop trigger if exists course_load_requests_limit on public.course_load_requests;
create trigger course_load_requests_limit
  before insert on public.course_load_requests
  for each row execute function private.limit_course_load_requests();
