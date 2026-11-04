-- The player's choice of Rounds backdrop for a course (null = pick from the
-- course's style tags and altitude).
alter table public.live_course_info
  add column if not exists backdrop text;

alter table public.live_course_info
  drop constraint if exists live_course_info_backdrop_known;
alter table public.live_course_info
  add constraint live_course_info_backdrop_known
  check (backdrop is null or backdrop in ('links', 'parkland', 'mountain', 'coastal', 'desert', 'heathland', 'tropical'));
