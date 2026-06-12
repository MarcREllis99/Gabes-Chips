-- ============================================================
-- Blackjack: dealer vs. players rework
-- 1. start_game now allows blackjack with a single player
--    (everyone plays against the house dealer, not each other)
-- 2. finish_blackjack(): per-player payouts —
--    win pays 1:1, blackjack pays 3:2, push returns the stake,
--    lose forfeits the stake. No rake; the dealer's edge is the
--    house take.
-- ============================================================

-- 1. Re-create start_game with a game-aware minimum player count
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

  v_min_players := case when p_game_type = 'blackjack' then 1 else 2 end;

  select count(*) into v_player_count
  from lobby_players where lobby_id = p_lobby_id;
  if v_player_count < v_min_players then
    raise exception 'Not enough players';
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

-- 2. Per-player blackjack payouts.
--    p_results: [{"player_id": "<uuid>", "outcome": "win"|"lose"|"push"|"blackjack"}]
--    Idempotent: only pays while the lobby is still active.
create or replace function public.finish_blackjack(
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
  v_payout integer;
  r record;
begin
  select * into v_game from games where id = p_game_id;
  if not found then
    raise exception 'Game not found';
  end if;

  select * into v_lobby from lobbies where id = v_game.lobby_id;
  if v_lobby.status <> 'active' then
    return; -- already paid out
  end if;

  if not exists (
    select 1 from lobby_players
    where lobby_id = v_game.lobby_id and user_id = auth.uid()
  ) then
    raise exception 'Only players in this game can finish it';
  end if;

  v_stake := coalesce((v_game.state->>'stake')::integer, 0);

  for r in
    select * from jsonb_to_recordset(p_results) as x(player_id uuid, outcome text)
  loop
    -- ignore anyone not actually in this game
    if not exists (
      select 1 from lobby_players
      where lobby_id = v_game.lobby_id and user_id = r.player_id
    ) then
      continue;
    end if;

    v_payout := case r.outcome
      when 'blackjack' then floor(v_stake * 2.5)
      when 'win' then v_stake * 2
      when 'push' then v_stake
      else 0
    end;

    if v_payout > 0 then
      update profiles
      set chip_balance = chip_balance + v_payout
      where id = r.player_id;
    end if;
  end loop;

  update lobbies set status = 'finished' where id = v_game.lobby_id;
end;
$$;
