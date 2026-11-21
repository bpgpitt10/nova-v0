-- How full the Supabase project is (admin page /admin/courses). Totals only: no rows, no players.
create or replace function public.admin_space_usage()
returns table (
  database_bytes bigint,
  file_bytes bigint,
  course_file_bytes bigint,
  full_courses integer,
  area_courses integer,
  shot_rows bigint,
  shot_bytes bigint
)
language plpgsql
stable
security definer
set search_path = public, storage
as $$
begin
  if not private.is_admin_user() then
    raise exception 'admins only';
  end if;
  return query
    select pg_database_size(current_database())::bigint,
           (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o)::bigint,
           (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o where o.bucket_id = 'course-packages')::bigint,
           (select count(*) from public.loaded_courses)::integer,
           (select count(*) from public.loaded_course_areas a where not exists (select 1 from public.loaded_courses l where l.slug = a.slug))::integer,
           (select count(*) from public.live_course_shots)::bigint,
           (pg_total_relation_size('public.live_course_shots') + pg_total_relation_size('public.live_caddie_lineage_records')
             + pg_total_relation_size('public.live_putt_details') + pg_total_relation_size('public.shots'))::bigint;
end;
$$;

revoke all on function public.admin_space_usage() from public;
revoke all on function public.admin_space_usage() from anon;
grant execute on function public.admin_space_usage() to authenticated;
