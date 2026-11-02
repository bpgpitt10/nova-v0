-- Course name and par per hole for each GSPro course key a player has played.
-- Written by whichever device first reads the course (the sim PC, through the
-- companion's GKD access, or a loaded course package) so every device can show
-- the real course name, par, greens in regulation and fairways.
create table if not exists public.live_course_info (
  user_id uuid not null references auth.users(id) on delete cascade,
  course_key text not null,
  course_name text,
  pars jsonb not null default '{}'::jsonb,
  par_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, course_key),
  constraint live_course_info_pars_object check (jsonb_typeof(pars) = 'object'),
  constraint live_course_info_par_source check (par_source is null or par_source in ('course-file', 'course-package')),
  constraint live_course_info_course_key_length check (char_length(course_key) between 1 and 120),
  constraint live_course_info_course_name_length check (course_name is null or char_length(course_name) <= 120)
);

alter table public.live_course_info enable row level security;

drop policy if exists "users own live course info" on public.live_course_info;
create policy "users own live course info"
on public.live_course_info
for all
using (
  user_id = (select auth.uid())
  and private.is_allowed_user()
)
with check (
  user_id = (select auth.uid())
  and private.is_allowed_user()
);

revoke all on table public.live_course_info from anon;
grant select, insert, update, delete on table public.live_course_info to authenticated;
grant all on table public.live_course_info to service_role;
