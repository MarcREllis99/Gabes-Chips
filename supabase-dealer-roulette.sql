-- ============================================================
-- Dealer Roulette — human dealer (the bank) for Blackjack & Free Bet
--
-- When a lobby has a dealer_id set (chosen by the roulette), that
-- player banks the table: they don't ante, and chips settle zero-sum
-- between them and every other player. No house edge in this mode.
--
-- If dealer_id is null, blackjack/free_bet still play the automated
-- house dealer exactly as before.
-- ============================================================

-- 1. Which player is the dealer for this lobby (null = automated house)
alter table public.lobbies
  add column if not exists dealer_id uuid references public.profiles(id) on delete set null;

-- 2. start_game: skip the dealer's ante; require 2+ players in dealer mode.
--    Reads the dealer straight off the lobby row (set by the roulette).
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

  -- A human dealer only applies to the dealer-style blackjack games
  if p_game_type in ('blackjack', 'free_bet') then
    v_dealer := v_lobby.dealer_id;
  else
    v_dealer := null;
  end if;

  v_min_players := case when p_game_type in ('blackjack', 'three_card', 'free_bet') then 1 else 2 end;
  if v_dealer is not null then v_min_players := 2; end if;

  select count(*) into v_player_count from lobby_players where lobby_id = p_lobby_id;
  if v_player_count < v_min_players then raise exception 'Not enough players'; end if;

  if v_dealer is not null and not exists (
    select 1 from lobby_players where lobby_id = p_lobby_id and user_id = v_dealer
  ) then
    raise exception 'Chosen dealer is no longer in the lobby';
  end if;

  -- Everyone antes, except the dealer (the dealer banks the table)
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

-- 3. finish_dealer_game: settle zero-sum against the human dealer.
--    p_results: [{"player_id": "<uuid>", "outcome": "win|lose|push|blackjack|win_double"}]
--    (the dealer is NOT included in p_results)
--    Pays each player their winnings; the dealer collects all antes and
--    covers all payouts, so dealer_credit = n*stake - sum(payouts).
create or replace function public.finish_dealer_game(
  p_game_id uuid,
  p_results jsonb
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_game games%rowtype;
  v_lobby lobbies%rowtype;
  v_stake integer;
  v_dealer uuid;
  v_total_payout integer := 0;
  v_n integer := 0;
  v_payout integer;
  v_dealer_credit integer;
  r record;
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

  v_dealer := v_lobby.dealer_id;
  if v_dealer is null then raise exception 'No dealer set for this game'; end if;
  v_stake := coalesce((v_game.state->>'stake')::integer, 0);

  for r in select * from jsonb_to_recordset(p_results) as x(player_id uuid, outcome text) loop
    if r.player_id = v_dealer then continue; end if;
    if not exists (
      select 1 from lobby_players where lobby_id = v_game.lobby_id and user_id = r.player_id
    ) then continue; end if;

    v_payout := case r.outcome
      when 'win_double' then v_stake * 3
      when 'blackjack' then floor(v_stake * 2.5)
      when 'win' then v_stake * 2
      when 'push' then v_stake
      else 0
    end;

    if v_payout > 0 then
      update profiles set chip_balance = chip_balance + v_payout where id = r.player_id;
    end if;

    v_total_payout := v_total_payout + v_payout;
    v_n := v_n + 1;
  end loop;

  -- Dealer banks: collected n antes, paid out total_payout (can be negative)
  v_dealer_credit := v_n * v_stake - v_total_payout;
  update profiles set chip_balance = chip_balance + v_dealer_credit where id = v_dealer;

  update lobbies set status = 'finished' where id = v_game.lobby_id;
end;
$$;

revoke execute on function public.finish_dealer_game(uuid, jsonb) from public, anon;
grant execute on function public.finish_dealer_game(uuid, jsonb) to authenticated;
