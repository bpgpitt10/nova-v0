-- Which GSPro courses players have installed, as counts only (admin page /admin/courses).
-- Each player's library stays private: this returns how many players have a course,
-- never who. The crosswalk columns say whether there is a real course to load and where.
create or replace function public.admin_course_installs()
returns table (
  course_key text,
  course_name text,
  location text,
  players integer,
  crosswalk_status text,
  lat double precision,
  lon double precision,
  osm_type text,
  osm_id bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not private.is_admin_user() then
    raise exception 'admins only';
  end if;
  return query
    select g.course_key::text,
           max(g.course_name)::text,
           max(g.location)::text,
           count(distinct g.user_id)::integer,
           max(c.status)::text,
           max(c.lat)::double precision,
           max(c.lon)::double precision,
           max(c.osm_type)::text,
           max(c.osm_id)::bigint
    from public.gspro_library g
    left join public.course_crosswalk c on c.gspro_keys @> array[g.course_key::text]
    group by g.course_key
    order by count(distinct g.user_id) desc, max(g.course_name);
end;
$$;

revoke all on function public.admin_course_installs() from public;
revoke all on function public.admin_course_installs() from anon;
grant execute on function public.admin_course_installs() to authenticated;
