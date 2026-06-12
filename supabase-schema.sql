-- ============================================================
-- Gabe's Chips — Supabase Schema
-- Run this in your Supabase SQL Editor
-- ============================================================

-- Profiles table
create table if not exists public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  username text not null unique,
  chip_balance integer not null default 1000,
  created_at timestamptz default now() not null
);

-- Lobbies table
create table if not exists public.lobbies (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  code text not null unique,
  host_id uuid references public.profiles(id) on delete cascade not null,
  status text not null default 'waiting' check (status in ('waiting', 'active', 'finished')),
  max_players integer not null check (max_players between 2 and 8),
  buy_in integer not null check (buy_in > 0),
  created_at timestamptz default now() not null
);

-- Lobby players table
create table if not exists public.lobby_players (
  id uuid default gen_random_uuid() primary key,
  lobby_id uuid references public.lobbies(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  joined_at timestamptz default now() not null,
  unique(lobby_id, user_id)
);

-- Games table
create table if not exists public.games (
  id uuid default gen_random_uuid() primary key,
  lobby_id uuid references public.lobbies(id) on delete cascade not null,
  game_type text not null check (game_type in ('coin_flip', 'higher_lower')),
  state jsonb not null default '{}',
  winner_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz default now() not null
);

-- ============================================================
-- Indexes
-- ============================================================
create index if not exists lobbies_status_idx on public.lobbies(status);
create index if not exists lobbies_code_idx on public.lobbies(code);
create index if not exists lobby_players_lobby_id_idx on public.lobby_players(lobby_id);
create index if not exists lobby_players_user_id_idx on public.lobby_players(user_id);
create index if not exists games_lobby_id_idx on public.games(lobby_id);

-- ============================================================
-- Row Level Security (RLS)
-- ============================================================
alter table public.profiles enable row level security;
alter table public.lobbies enable row level security;
alter table public.lobby_players enable row level security;
alter table public.games enable row level security;

-- Profiles policies
create policy "Public profiles are viewable by authenticated users"
  on public.profiles for select
  to authenticated
  using (true);

create policy "Users can insert their own profile"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id);

-- Lobbies policies
create policy "Lobbies are viewable by authenticated users"
  on public.lobbies for select
  to authenticated
  using (true);

create policy "Authenticated users can create lobbies"
  on public.lobbies for insert
  to authenticated
  with check (auth.uid() = host_id);

create policy "Host can update their lobby"
  on public.lobbies for update
  to authenticated
  using (auth.uid() = host_id);

-- Allow game system to update lobby status (via service role or host)
-- For simplicity, allow any authenticated player in the lobby to update status
create policy "Players in lobby can update lobby status"
  on public.lobbies for update
  to authenticated
  using (
    auth.uid() = host_id or
    exists (
      select 1 from public.lobby_players
      where lobby_id = lobbies.id and user_id = auth.uid()
    )
  );

-- Lobby players policies
create policy "Lobby players viewable by authenticated users"
  on public.lobby_players for select
  to authenticated
  using (true);

create policy "Authenticated users can join lobbies"
  on public.lobby_players for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can leave lobbies"
  on public.lobby_players for delete
  to authenticated
  using (auth.uid() = user_id);

-- Games policies
create policy "Games are viewable by authenticated users"
  on public.games for select
  to authenticated
  using (true);

create policy "Host can create games"
  on public.games for insert
  to authenticated
  with check (
    exists (
      select 1 from public.lobbies
      where id = lobby_id and host_id = auth.uid()
    )
  );

create policy "Players in lobby can update game state"
  on public.games for update
  to authenticated
  using (
    exists (
      select 1 from public.lobby_players
      where lobby_id = games.lobby_id and user_id = auth.uid()
    )
  );

-- ============================================================
-- Realtime
-- Enable realtime for lobby_players and games tables
-- ============================================================
-- Run these in the Supabase dashboard under Database > Replication
-- or uncomment if your project supports it via SQL:
--
-- alter publication supabase_realtime add table public.lobby_players;
-- alter publication supabase_realtime add table public.games;
-- alter publication supabase_realtime add table public.lobbies;
