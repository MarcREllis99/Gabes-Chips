-- ============================================================
-- Multi-round (bankroll) games: Blackjack, Free Bet, Texas Hold'em, 3 Card.
-- The host-set "stake" is now a BUY-IN: it is deducted from each player's
-- chip_balance at start and each player's table stack is tracked inside
-- games.state.stacks {playerId: chips}. Rounds run inside one game; chips
-- only touch chip_balance at buy-in, on a rebuy, and at the final settle.
--   * finish_table_game  — credit every player's final stack back, end the game
--   * table_rebuy        — host/dealer approves topping a player's stack back up
-- Single-round games (coin flip, higher/lower, euchre, war, gabe's wilds)
-- keep the old start_game/finish_* behaviour.
-- ============================================================

-- Keep the game_type constraints at the full set (idempotent).
alter table public.lobbies drop constraint if exists lobbies_game_type_check;
alter table public.lobbies add constraint lobbies_game_type_check
  check (game_type in ('coin_flip','higher_lower','blackjack','texas_holdem','three_card','free_bet','euchre','gabes_wilds','war','chip_tracker'));
alter table public.games drop constraint if exists games_game_type_check;
alter table public.games add constraint games_game_type_check
  check (game_type in ('coin_flip','higher_lower','blackjack','texas_holdem','three_card','free_bet','euchre','gabes_wilds','war','chip_tracker'));

-- start_game: for bankroll games the buy-in is charged to EVERY player
-- (including a human dealer, who banks the table with their own stack).
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
  v_bankroll boolean;
begin
  select * into v_lobby from lobbies where id = p_lobby_id;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_id <> auth.uid() then raise exception 'Only the host can start the game'; end if;
  if v_lobby.status <> 'waiting' then raise exception 'Game already started'; end if;
  if p_stake is null or p_stake <= 0 then raise exception 'Stake must be a positive number'; end if;

  v_bankroll := p_game_type in ('blackjack', 'free_bet', 'texas_holdem', 'three_card');

  -- A human dealer (the bank) only applies to the dealer-style blackjack games
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

  if v_bankroll then
    -- Buy-in: charge everyone (the dealer brings a bankroll too).
    update profiles
    set chip_balance = chip_balance - p_stake
    where id in (select user_id from lobby_players where lobby_id = p_lobby_id);
  else
    -- Single-round ante: everyone except a (legacy) bank dealer.
    update profiles
    set chip_balance = chip_balance - p_stake
    where id in (select user_id from lobby_players where lobby_id = p_lobby_id)
      and (v_dealer is null or id <> v_dealer);
  end if;

  insert into games (lobby_id, game_type, state)
  values (p_lobby_id, p_game_type, jsonb_build_object('stake', p_stake))
  returning id into v_game_id;

  update lobbies set status = 'active' where id = p_lobby_id;
  return v_game_id;
end;
$$;

-- Credit every player's final table stack back to their chip_balance and end
-- the game. Idempotent (no-op once the lobby is no longer 'active').
create or replace function public.finish_table_game(p_game_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_game games%rowtype;
  v_lobby lobbies%rowtype;
  r record;
  v_best integer := null;
  v_winner uuid := null;
begin
  select * into v_game from games where id = p_game_id for update;
  if not found then raise exception 'Game not found'; end if;
  select * into v_lobby from lobbies where id = v_game.lobby_id;
  if v_lobby.status <> 'active' then return; end if; -- already settled
  if not exists (
    select 1 from lobby_players where lobby_id = v_game.lobby_id and user_id = auth.uid()
  ) then
    raise exception 'Only players in this game can finish it';
  end if;

  for r in
    select key as pid, (value)::int as stack
    from jsonb_each_text(coalesce(v_game.state->'stacks', '{}'::jsonb))
  loop
    if exists (select 1 from lobby_players where lobby_id = v_game.lobby_id and user_id = r.pid::uuid) then
      if r.stack <> 0 then
        update profiles set chip_balance = chip_balance + r.stack where id = r.pid::uuid;
      end if;
      if v_best is null or r.stack > v_best then v_best := r.stack; v_winner := r.pid::uuid; end if;
    end if;
  end loop;

  update games set winner_id = v_winner where id = p_game_id;
  update lobbies set status = 'finished' where id = v_game.lobby_id;
end;
$$;

-- Host or the table's dealer tops a player's stack back up mid-game (a rebuy).
-- Moves p_amount from the player's chip_balance onto the table.
create or replace function public.table_rebuy(p_game_id uuid, p_player_id uuid, p_amount integer)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_game games%rowtype;
  v_lobby lobbies%rowtype;
  v_bal integer;
  v_stack integer;
  st jsonb;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  select * into v_game from games where id = p_game_id for update;
  if not found then raise exception 'Game not found'; end if;
  select * into v_lobby from lobbies where id = v_game.lobby_id;
  if v_lobby.status <> 'active' then raise exception 'Game is not running'; end if;
  if auth.uid() <> v_lobby.host_id and (v_lobby.dealer_id is null or auth.uid() <> v_lobby.dealer_id) then
    raise exception 'Only the host or dealer can approve a rebuy';
  end if;
  if not exists (select 1 from lobby_players where lobby_id = v_game.lobby_id and user_id = p_player_id) then
    raise exception 'That player is not in the game';
  end if;

  select chip_balance into v_bal from profiles where id = p_player_id;
  if v_bal < p_amount then raise exception 'Player does not have enough chips to rebuy that much'; end if;

  update profiles set chip_balance = chip_balance - p_amount where id = p_player_id;

  st := coalesce(v_game.state, '{}'::jsonb);
  if not (st ? 'stacks') then st := jsonb_set(st, '{stacks}', '{}'::jsonb, true); end if;
  v_stack := coalesce((st->'stacks'->>p_player_id::text)::int, 0);
  st := jsonb_set(st, array['stacks', p_player_id::text], to_jsonb(v_stack + p_amount), true);
  -- clear any pending rebuy request for this player
  if st ? 'rebuyReq' then
    st := jsonb_set(st, '{rebuyReq}', (st->'rebuyReq') - p_player_id::text);
  end if;
  update games set state = st where id = p_game_id;
end;
$$;

revoke execute on function public.finish_table_game(uuid) from public, anon;
revoke execute on function public.table_rebuy(uuid, uuid, integer) from public, anon;
grant execute on function public.finish_table_game(uuid) to authenticated;
grant execute on function public.table_rebuy(uuid, uuid, integer) to authenticated;
