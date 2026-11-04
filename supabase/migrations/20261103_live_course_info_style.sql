-- The GSPro course designer's style tags (links, parkland, mountain, coastal...)
-- and altitude, from the course file via the companion. Rounds uses them to pick
-- a backdrop that fits the course.
alter table public.live_course_info
  add column if not exists style_keywords jsonb,
  add column if not exists altitude_ft double precision;

alter table public.live_course_info
  drop constraint if exists live_course_info_style_keywords_array;
alter table public.live_course_info
  add constraint live_course_info_style_keywords_array
  check (style_keywords is null or jsonb_typeof(style_keywords) = 'array');
