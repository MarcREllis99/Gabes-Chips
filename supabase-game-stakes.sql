-- ============================================================
-- Stakes-at-game-start rework
-- 1. New accounts start at 0 chips (balance = net winnings ledger)
-- 2. Lobbies no longer charge a buy-in
-- 3. start_game(): host sets the stake; it's deducted from every
--    player in the lobby and the game row is created
-- 4. finish_game(): pays the winner the pot minus the 5% rake
--    (server-side, so RLS can't block cross-player balance updates)
-- ============================================================

-- 1. New users start at 0
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, chip_balance)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'Player_' || substr(new.id::text, 1, 6)),
    0
  );
  return new;
end;
$$;

alter table public.profiles alter column chip_balance set default 0;

-- 2. buy_in is unused now; relax the > 0 check so lobbies can store 0
alter table public.lobbies drop constraint if exists lobbies_buy_in_check;
alter table public.lobbies add constraint lobbies_buy_in_check check (buy_in >= 0);

-- 3. Start a game: host-only, deducts the stake from all players
create or replace function public.start_game(
  p_lobby_id uuid,
  p_game_type text,
  p_stake integer
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_lobby lobbies%rowtype;
  v_player_count integer;
  v_game_id uuid;
begin
  select * into v_lobby from lobbies where id = p_lobby_id;
  if not found then
    raise exception 'Lobby not found';
  end if;
  if v_lobby.host_id <> auth.uid() then
    raise exception 'Only the host can start the game';
  end if;
  if v_lobby.status <> 'waiting' then
    raise exception 'Game already started';
  end if;
  if p_stake is null or p_stake <= 0 then
    raise exception 'Stake must be a positive number';
  end if;

  select count(*) into v_player_count
  from lobby_players where lobby_id = p_lobby_id;
  if v_player_count < 2 then
    raise exception 'Need at least 2 players';
  end if;

  -- Collect the stake from every player in the lobby
  update profiles
  set chip_balance = chip_balance - p_stake
  where id in (select user_id from lobby_players where lobby_id = p_lobby_id);

  insert into games (lobby_id, game_type, state)
  values (p_lobby_id, p_game_type, jsonb_build_object('stake', p_stake))
  returning id into v_game_id;

  update lobbies set status = 'active' where id = p_lobby_id;

  return v_game_id;
end;
$$;

-- 4. Finish a game: pays the winner, marks everything done.
--    Idempotent — a second call for the same game does nothing.
create or replace function public.finish_game(
  p_game_id uuid,
  p_winner_id uuid
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_game games%rowtype;
  v_stake integer;
  v_player_count integer;
  v_payout integer;
begin
  select * into v_game from games where id = p_game_id;
  if not found then
    raise exception 'Game not found';
  end if;
  if v_game.winner_id is not null then
    return; -- already paid out
  end if;

  if not exists (
    select 1 from lobby_players
    where lobby_id = v_game.lobby_id and user_id = auth.uid()
  ) then
    raise exception 'Only players in this game can finish it';
  end if;

  if not exists (
    select 1 from lobby_players
    where lobby_id = v_game.lobby_id and user_id = p_winner_id
  ) then
    raise exception 'Winner is not in this game';
  end if;

  v_stake := coalesce((v_game.state->>'stake')::integer, 0);
  select count(*) into v_player_count
  from lobby_players where lobby_id = v_game.lobby_id;
  v_payout := floor(v_stake * v_player_count * 0.95);

  update profiles set chip_balance = chip_balance + v_payout where id = p_winner_id;
  update games set winner_id = p_winner_id where id = p_game_id;
  update lobbies set status = 'finished' where id = v_game.lobby_id;
end;
$$;
