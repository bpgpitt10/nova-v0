-- "scorecard": pars from GSPro's own scorecard, which beat the course file
-- (The Old Game's file has hole 7 as a par 4; GSPro scores it as a 5).
alter table public.live_course_info drop constraint if exists live_course_info_par_source;
alter table public.live_course_info add constraint live_course_info_par_source
  check (par_source is null or par_source = any (array['scorecard'::text, 'course-file'::text, 'course-package'::text]));
