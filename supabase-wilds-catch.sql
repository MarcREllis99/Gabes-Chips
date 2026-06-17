-- ============================================================
-- Gabe's Wilds — "didn't call it" catch.
-- When a player drops to one card, game.state.oneCard = {pid} marks them
-- catchable. Two row-locked RPCs race for that row:
--   wilds_call  — the one-card player calls in time → clears oneCard (safe)
--   wilds_catch — someone catches them first → that player draws 4, oneCard clears
-- Whichever RPC commits first wins (FOR UPDATE serializes them).
-- ============================================================

create or replace function public.wilds_call(p_game_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare st jsonb; caller uuid := auth.uid();
begin
  select state into st from games where id = p_game_id for update;
  if st is null then return; end if;
  if coalesce(st->'oneCard'->>'pid', '') = caller::text then
    update games set state = (st - 'oneCard') where id = p_game_id;
  end if;
end;
$$;

create or replace function public.wilds_catch(p_game_id uuid, p_target uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  st jsonb;
  draw jsonb;
  disc jsonb;
  hand jsonb;
  topc jsonb;
  moved int := 0;
  caller uuid := auth.uid();
  v_name text;
begin
  select state into st from games where id = p_game_id for update;
  if st is null then return; end if;
  if not exists (
    select 1 from games g join lobby_players lp on lp.lobby_id = g.lobby_id
    where g.id = p_game_id and lp.user_id = caller
  ) then
    raise exception 'Not in this game';
  end if;

  if coalesce(st->'oneCard'->>'pid', '') <> p_target::text then return; end if; -- already called / caught
  if caller = p_target then return; end if;                                     -- can't catch yourself

  hand := coalesce(st->'hands'->(p_target::text), '[]'::jsonb);
  if jsonb_array_length(hand) <> 1 then
    update games set state = (st - 'oneCard') where id = p_game_id;             -- stale flag, clear it
    return;
  end if;

  draw := coalesce(st->'drawPile', '[]'::jsonb);
  disc := coalesce(st->'discard', '[]'::jsonb);

  -- draw 4 onto the target, reshuffling the discard (minus its top) when empty
  while moved < 4 loop
    if jsonb_array_length(draw) = 0 then
      if jsonb_array_length(disc) <= 1 then exit; end if;
      topc := disc -> -1;
      select coalesce(jsonb_agg(e order by random()), '[]'::jsonb) into draw
        from jsonb_array_elements(disc - (jsonb_array_length(disc) - 1)) e;
      disc := jsonb_build_array(topc);
    end if;
    exit when jsonb_array_length(draw) = 0;
    hand := hand || jsonb_build_array(draw -> -1);
    draw := draw - (jsonb_array_length(draw) - 1);
    moved := moved + 1;
  end loop;

  select username into v_name from profiles where id = p_target;
  st := jsonb_set(st, array['hands', p_target::text], hand);
  st := jsonb_set(st, '{drawPile}', draw);
  st := jsonb_set(st, '{discard}', disc);
  st := st - 'oneCard';
  st := jsonb_set(st, '{lastAction}', to_jsonb(coalesce(v_name, 'A player') || ' got caught — drew 4!'));
  update games set state = st where id = p_game_id;
end;
$$;

revoke execute on function public.wilds_call(uuid) from public, anon;
revoke execute on function public.wilds_catch(uuid, uuid) from public, anon;
grant execute on function public.wilds_call(uuid) to authenticated;
grant execute on function public.wilds_catch(uuid, uuid) to authenticated;
