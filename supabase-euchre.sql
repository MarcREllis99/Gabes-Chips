-- ============================================================
-- Euchre — 4-player partnership trick game
-- 1. Allow 'euchre' as a game type
-- 2. start_game requires exactly the right count (euchre = 4)
-- 3. finish_team_game: split the pot (minus 5% rake) between the
--    two players on the winning team
-- ============================================================

alter table public.lobbies drop constraint if exists lobbies_game_type_check;
alter table public.lobbies add constraint lobbies_game_type_check
  check (game_type in ('coin_flip','higher_lower','blackjack','texas_holdem','three_card','free_bet','euchre'));

alter table public.games drop constraint if exists games_game_type_check;
alter table public.games add constraint games_game_type_check
  check (game_type in ('coin_flip','higher_lower','blackjack','texas_holdem','three_card','free_bet','euchre'));

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
  v_min_players integer;
  v_dealer uuid;
  v_game_id uuid;
begin
  select * into v_lobby from lobbies where id = p_lobby_id;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_id <> auth.uid() then raise exception 'Only the host can start the game'; end if;
  if v_lobby.status <> 'waiting' then raise exception 'Game already started'; end if;
  if p_stake is null or p_stake <= 0 then raise exception 'Stake must be a positive number'; end if;

  -- Human dealer (the bank) only applies to the dealer-style blackjack games
  if p_game_type in ('blackjack', 'free_bet') then
    v_dealer := v_lobby.dealer_id;
  else
    v_dealer := null;
  end if;

  v_min_players := case
    when p_game_type = 'euchre' then 4
    when p_game_type in ('blackjack', 'three_card', 'free_bet') then 1
    else 2
  end;
  if v_dealer is not null then v_min_players := 2; end if;

  select count(*) into v_player_count from lobby_players where lobby_id = p_lobby_id;
  if v_player_count < v_min_players then raise exception 'Not enough players'; end if;
  if p_game_type = 'euchre' and v_player_count <> 4 then
    raise exception 'Euchre needs exactly 4 players';
  end if;

  if v_dealer is not null and not exists (
    select 1 from lobby_players where lobby_id = p_lobby_id and user_id = v_dealer
  ) then
    raise exception 'Chosen dealer is no longer in the lobby';
  end if;

  -- Everyone antes, except the bank dealer when there is one
  update profiles
  set chip_balance = chip_balance - p_stake
  where id in (select user_id from lobby_players where lobby_id = p_lobby_id)
    and (v_dealer is null or id <> v_dealer);

  insert into games (lobby_id, game_type, state)
  values (p_lobby_id, p_game_type, jsonb_build_object('stake', p_stake))
  returning id into v_game_id;

  update lobbies set status = 'active' where id = p_lobby_id;
  return v_game_id;
end;
$$;

-- Split the pot among the winning team (minus the 5% rake).
create or replace function public.finish_team_game(
  p_game_id uuid,
  p_winner_ids uuid[]
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_game games%rowtype;
  v_lobby lobbies%rowtype;
  v_stake integer;
  v_player_count integer;
  v_total integer;
  v_each integer;
  v_winner uuid;
begin
  select * into v_game from games where id = p_game_id;
  if not found then raise exception 'Game not found'; end if;

  select * into v_lobby from lobbies where id = v_game.lobby_id;
  if v_lobby.status <> 'active' then return; end if; -- already settled

  if not exists (
    select 1 from lobby_players where lobby_id = v_game.lobby_id and user_id = auth.uid()
  ) then
    raise exception 'Only players in this game can finish it';
  end if;

  if p_winner_ids is null or array_length(p_winner_ids, 1) is null then
    raise exception 'No winners provided';
  end if;

  v_stake := coalesce((v_game.state->>'stake')::integer, 0);
  select count(*) into v_player_count from lobby_players where lobby_id = v_game.lobby_id;
  v_total := floor(v_stake * v_player_count * 0.95);
  v_each := floor(v_total / array_length(p_winner_ids, 1));

  foreach v_winner in array p_winner_ids loop
    if exists (select 1 from lobby_players where lobby_id = v_game.lobby_id and user_id = v_winner) then
      update profiles set chip_balance = chip_balance + v_each where id = v_winner;
    end if;
  end loop;

  -- Record one of the winners so the games feed shows a name
  update games set winner_id = p_winner_ids[1] where id = p_game_id;
  update lobbies set status = 'finished' where id = v_game.lobby_id;
end;
$$;

revoke execute on function public.finish_team_game(uuid, uuid[]) from public, anon;
grant execute on function public.finish_team_game(uuid, uuid[]) to authenticated;
