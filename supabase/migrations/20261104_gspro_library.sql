-- Each player's installed GSPro courses (names, locations, keys; no paths or
-- course files), saved when the Load page reads them from the companion on
-- the sim PC, so the Load page can list them on any device (MacBook, phone).

create table if not exists public.gspro_library (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  course_key text not null check (char_length(course_key) between 1 and 160),
  course_name text not null default '' check (char_length(course_name) <= 160),
  location text not null default '' check (char_length(location) <= 160),
  designer text not null default '' check (char_length(designer) <= 160),
  holes int not null default 18 check (holes between 1 and 36),
  seen_at timestamptz not null default now(),
  primary key (user_id, course_key)
);

alter table public.gspro_library enable row level security;

create policy "players read their gspro library"
  on public.gspro_library for select to authenticated
  using (user_id = auth.uid() and private.is_allowed_user());

create policy "players save their gspro library"
  on public.gspro_library for insert to authenticated
  with check (user_id = auth.uid() and private.is_allowed_user());

create policy "players update their gspro library"
  on public.gspro_library for update to authenticated
  using (user_id = auth.uid() and private.is_allowed_user())
  with check (user_id = auth.uid() and private.is_allowed_user());

create policy "players remove from their gspro library"
  on public.gspro_library for delete to authenticated
  using (user_id = auth.uid() and private.is_allowed_user());
