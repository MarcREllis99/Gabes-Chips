-- ============================================================
-- No house rake. The app never skims chips — winners take the FULL pot.
-- Redefines finish_game and finish_team_game to pay out the whole pot
-- (previously floor(pot * 0.95)). Run this once in the SQL editor.
-- (The bankroll games already settle rake-free via finish_table_game.)
-- ============================================================

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
  if not found then raise exception 'Game not found'; end if;
  if v_game.winner_id is not null then return; end if; -- already paid out

  if not exists (
    select 1 from lobby_players where lobby_id = v_game.lobby_id and user_id = auth.uid()
  ) then
    raise exception 'Only players in this game can finish it';
  end if;
  if not exists (
    select 1 from lobby_players where lobby_id = v_game.lobby_id and user_id = p_winner_id
  ) then
    raise exception 'Winner is not in this game';
  end if;

  v_stake := coalesce((v_game.state->>'stake')::integer, 0);
  select count(*) into v_player_count from lobby_players where lobby_id = v_game.lobby_id;
  v_payout := v_stake * v_player_count; -- full pot, no rake

  update profiles set chip_balance = chip_balance + v_payout where id = p_winner_id;
  update games set winner_id = p_winner_id where id = p_game_id;
  update lobbies set status = 'finished' where id = v_game.lobby_id;
end;
$$;

-- Split the FULL pot among the winning team (no rake).
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
  v_total := v_stake * v_player_count; -- full pot, no rake
  v_each := floor(v_total / array_length(p_winner_ids, 1));

  foreach v_winner in array p_winner_ids loop
    if exists (select 1 from lobby_players where lobby_id = v_game.lobby_id and user_id = v_winner) then
      update profiles set chip_balance = chip_balance + v_each where id = v_winner;
    end if;
  end loop;

  update games set winner_id = p_winner_ids[1] where id = p_game_id;
  update lobbies set status = 'finished' where id = v_game.lobby_id;
end;
$$;
