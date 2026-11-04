-- Where a GSPro course sits on its loaded Looper course, so Rounds can draw a
-- round's shots on the real hole on every device. The alignment is fitted on
-- the sim PC (the GSPro course file plus the course's LiDAR package) and kept
-- here; it holds no GSPro geometry, only the transform.
alter table public.live_course_info
  add column if not exists course_id text,
  add column if not exists registration jsonb;

alter table public.live_course_info
  drop constraint if exists live_course_info_registration_object;
alter table public.live_course_info
  add constraint live_course_info_registration_object
  check (registration is null or jsonb_typeof(registration) = 'object');

alter table public.live_course_info
  drop constraint if exists live_course_info_course_id_length;
alter table public.live_course_info
  add constraint live_course_info_course_id_length
  check (course_id is null or char_length(course_id) <= 120);
