-- Keep launch-monitor-dependent metrics inside a stable measurement regime.
-- Historical raw Shot rows are preserved; sessions receive a lightweight
-- profile key used by the client when building mishit populations.

alter table public.sessions
  add column if not exists measurement_profile text;

update public.sessions s
set measurement_profile = case
  when exists (
    select 1
    from public.shots sh
    where sh.session_id = s.id
      and sh.source = 'simread'
  ) then 'gspro/simread-v1'
  when exists (
    select 1
    from public.shots sh
    where sh.session_id = s.id
      and sh.source in ('legacy_csv', 'legacy-import')
  ) then 'legacy/import-v1'
  when s.source = 'gspro' then 'gspro/simread-v1'
  when s.source = 'nova' then 'nova/direct-v1'
  when s.source = 'mock' then 'mock/v1'
  else 'legacy/unknown'
end
where measurement_profile is null
   or btrim(measurement_profile) = '';

create or replace function public.set_default_session_measurement_profile()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.measurement_profile is null or btrim(new.measurement_profile) = '' then
    new.measurement_profile := case
      when new.source = 'gspro' then 'gspro/simread-v1'
      when new.source = 'nova' then 'nova/direct-v1'
      when new.source = 'mock' then 'mock/v1'
      else 'legacy/unknown'
    end;
  end if;

  return new;
end;
$$;

drop trigger if exists sessions_default_measurement_profile on public.sessions;
create trigger sessions_default_measurement_profile
before insert or update of source, measurement_profile on public.sessions
for each row execute procedure public.set_default_session_measurement_profile();
