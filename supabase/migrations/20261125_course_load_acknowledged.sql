-- "Your courses" pop-up at sign-in: a player sees once what happened to the course loads they asked for.
-- acknowledged_at is set by "Got it"; only through this function, and only on the player's own requests.
alter table public.course_load_requests add column if not exists acknowledged_at timestamptz;

create or replace function public.acknowledge_course_loads(request_ids uuid[])
returns integer
language sql
security definer
set search_path = public
as $$
  with done as (
    update public.course_load_requests
       set acknowledged_at = now()
     where id = any(request_ids)
       and requested_by = auth.uid()
       and finished_at is not null
       and acknowledged_at is null
    returning 1
  )
  select count(*)::integer from done;
$$;

revoke all on function public.acknowledge_course_loads(uuid[]) from public, anon;
grant execute on function public.acknowledge_course_loads(uuid[]) to authenticated;
