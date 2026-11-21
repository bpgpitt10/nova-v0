-- Which GSPro player is this Looper account. GSPro writes the player's name and
-- GSPro account id (UserGuid) on every shot in currentRound.dat; on a sim several
-- people share, Looper keeps only the shots of the players the account has claimed.
-- 'mine' rows are claimed players; 'not-mine' rows are players the account said
-- aren't them, so it isn't asked about them again.
create table if not exists public.gspro_players (
  user_id uuid not null references auth.users (id) on delete cascade,
  player_guid text not null,
  player_name text,
  verdict text not null default 'mine' check (verdict in ('mine', 'not-mine')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, player_guid)
);

alter table public.gspro_players enable row level security;

drop policy if exists "users own gspro players" on public.gspro_players;
create policy "users own gspro players" on public.gspro_players
  for all
  using ((user_id = (select auth.uid())) and private.is_allowed_user())
  with check ((user_id = (select auth.uid())) and private.is_allowed_user());
