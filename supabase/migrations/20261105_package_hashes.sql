-- What exactly was published: the acceptance gate's hash and size of each package
-- (tools/course_model/validate_package.py). A client can refuse a package whose hash
-- doesn't match the row; a rebuild shows up as a changed hash.
alter table public.loaded_courses
  add column if not exists package_sha256 text,
  add column if not exists package_bytes integer,
  add column if not exists lidar_sha256 text;
alter table public.loaded_course_areas
  add column if not exists package_sha256 text,
  add column if not exists package_bytes integer;
