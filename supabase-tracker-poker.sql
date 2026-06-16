-- ============================================================
-- Chip Tracker — Texas Hold'em style POKER hand flow.
-- Repurposes lobbies.dealer_id as the rotating BUTTON for poker rooms.
-- Every stack is tracked in CENTS; lobby_players.chip_counts is just a
-- greedy denomination breakdown for the felt visuals (same approach as
-- the blackjack tracker — denominations are cosmetic, derived from cents).
--
-- lobbies.tracker_state (jsonb) holds the live hand:
--   { variant:'poker', phase:'idle'|'preflop'|'flop'|'turn'|'river'|'showdown',
--     pot, sb, bb, ante,                       -- cents
--     sbId, bbId,                              -- this hand's blind seats
--     folded:[uid], ready:[uid], contrib:{uid:cents} }
-- ============================================================

-- Greedy breakdown of cents into the room's denominations -> jsonb {value:count}.
create or replace function public._poker_breakdown(p_lobby_id uuid, p_cents integer)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_vals numeric[];
  v numeric; vc integer; n integer;
  rem integer := greatest(0, coalesce(p_cents, 0));
  out jsonb := '{}'::jsonb;
begin
  select array_agg(distinct (d->>'value')::numeric order by (d->>'value')::numeric desc)
    into v_vals
  from lobbies l, jsonb_array_elements(coalesce(l.tracker_config->'denominations', '[]'::jsonb)) d
  where l.id = p_lobby_id;
  if v_vals is null then return out; end if;
  foreach v in array v_vals loop
    vc := round(v * 100);
    if vc <= 0 then continue; end if;
    n := rem / vc;            -- integer division
    if n > 0 then
      out := out || jsonb_build_object(v::text, n);
      rem := rem - n * vc;
    end if;
  end loop;
  return out;
end;
$$;

-- Cents total of a chip_counts jsonb ({value:count}).
create or replace function public._cc_cents(p jsonb)
returns integer language sql immutable as $$
  select coalesce(sum(round((key)::numeric * 100) * (value::integer)), 0)::integer
  from jsonb_each_text(coalesce(p, '{}'::jsonb)) as e(key, value);
$$;

-- Host or current dealer sets the blind/ante structure (while idle).
create or replace function public.poker_set_blinds(p_lobby_id uuid, p_sb integer, p_bb integer, p_ante integer)
returns void language plpgsql security definer set search_path = public as $$
declare v_host uuid; v_btn uuid; st jsonb;
begin
  select host_id, dealer_id, tracker_state into v_host, v_btn, st from lobbies where id = p_lobby_id;
  if auth.uid() <> v_host and (v_btn is null or auth.uid() <> v_btn) then
    raise exception 'Only the host or dealer can set blinds';
  end if;
  st := coalesce(st, '{}'::jsonb);
  st := jsonb_set(st, '{sb}',   to_jsonb(greatest(coalesce(p_sb, 0), 0)), true);
  st := jsonb_set(st, '{bb}',   to_jsonb(greatest(coalesce(p_bb, 0), 0)), true);
  st := jsonb_set(st, '{ante}', to_jsonb(greatest(coalesce(p_ante, 0), 0)), true);
  if st->>'variant' is null then st := jsonb_set(st, '{variant}', to_jsonb('poker'::text), true); end if;
  if st->>'phase'   is null then st := jsonb_set(st, '{phase}',   to_jsonb('idle'::text),  true); end if;
  update lobbies set tracker_state = st where id = p_lobby_id;
end; $$;

-- Deal a new hand: rotate the button, post blinds + antes, open the pre-flop.
create or replace function public.poker_new_hand(p_lobby_id uuid, p_sb integer, p_bb integer, p_ante integer)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_host uuid; v_btn uuid; v_new_btn uuid;
  ids uuid[]; n int; idx int;
  sb_id uuid; bb_id uuid;
  st jsonb; contrib jsonb := '{}'::jsonb; pot int := 0;
  pid uuid; cents int; post int;
begin
  select host_id, dealer_id into v_host, v_btn from lobbies where id = p_lobby_id for update;
  if v_host is null then raise exception 'No such room'; end if;
  if auth.uid() <> v_host and (v_btn is null or auth.uid() <> v_btn) then
    raise exception 'Only the host or current dealer can deal';
  end if;

  select array_agg(user_id order by joined_at) into ids from lobby_players where lobby_id = p_lobby_id;
  n := array_length(ids, 1);
  if n is null or n < 2 then raise exception 'Need 2+ players'; end if;

  -- rotate the button
  if v_btn is null then
    v_new_btn := v_host;                      -- first hand: host takes the button
  else
    idx := array_position(ids, v_btn);
    if idx is null then idx := 0; end if;
    v_new_btn := ids[(idx % n) + 1];
  end if;
  idx := array_position(ids, v_new_btn);

  if n = 2 then
    sb_id := v_new_btn;                        -- heads-up: button posts the small blind
    bb_id := ids[(idx % n) + 1];
  else
    sb_id := ids[(idx % n) + 1];
    bb_id := ids[((idx + 1) % n) + 1];
  end if;

  update lobbies set dealer_id = v_new_btn where id = p_lobby_id;

  -- antes from everyone (capped at stack)
  if coalesce(p_ante, 0) > 0 then
    foreach pid in array ids loop
      select _cc_cents(chip_counts) into cents from lobby_players where lobby_id = p_lobby_id and user_id = pid;
      post := least(greatest(coalesce(p_ante, 0), 0), cents);
      if post > 0 then
        cents := cents - post; pot := pot + post;
        contrib := contrib || jsonb_build_object(pid::text, coalesce((contrib->>pid::text)::int, 0) + post);
        update lobby_players set chip_counts = _poker_breakdown(p_lobby_id, cents)
          where lobby_id = p_lobby_id and user_id = pid;
      end if;
    end loop;
  end if;

  -- small blind
  select _cc_cents(chip_counts) into cents from lobby_players where lobby_id = p_lobby_id and user_id = sb_id;
  post := least(greatest(coalesce(p_sb, 0), 0), cents);
  if post > 0 then
    cents := cents - post; pot := pot + post;
    contrib := contrib || jsonb_build_object(sb_id::text, coalesce((contrib->>sb_id::text)::int, 0) + post);
    update lobby_players set chip_counts = _poker_breakdown(p_lobby_id, cents) where lobby_id = p_lobby_id and user_id = sb_id;
  end if;

  -- big blind
  select _cc_cents(chip_counts) into cents from lobby_players where lobby_id = p_lobby_id and user_id = bb_id;
  post := least(greatest(coalesce(p_bb, 0), 0), cents);
  if post > 0 then
    cents := cents - post; pot := pot + post;
    contrib := contrib || jsonb_build_object(bb_id::text, coalesce((contrib->>bb_id::text)::int, 0) + post);
    update lobby_players set chip_counts = _poker_breakdown(p_lobby_id, cents) where lobby_id = p_lobby_id and user_id = bb_id;
  end if;

  st := jsonb_build_object(
    'variant', 'poker', 'phase', 'preflop',
    'pot', pot, 'sb', coalesce(p_sb, 0), 'bb', coalesce(p_bb, 0), 'ante', coalesce(p_ante, 0),
    'folded', '[]'::jsonb, 'ready', '[]'::jsonb, 'contrib', contrib,
    'sbId', sb_id, 'bbId', bb_id
  );
  update lobbies set tracker_state = st where id = p_lobby_id;
end; $$;

-- A player pushes chips into the pot (bet / call / raise). Self-authorized.
-- Caps at the player's stack (all-in); a bet reopens the action (clears ready).
create or replace function public.poker_post(p_lobby_id uuid, p_cents integer)
returns void language plpgsql security definer set search_path = public as $$
declare st jsonb; phase text; stackc int; post int; uid uuid := auth.uid();
begin
  if not exists (select 1 from lobby_players where lobby_id = p_lobby_id and user_id = uid) then
    raise exception 'You are not in this room';
  end if;
  select tracker_state into st from lobbies where id = p_lobby_id for update;
  if st is null then raise exception 'No hand in progress'; end if;
  phase := st->>'phase';
  if phase not in ('preflop', 'flop', 'turn', 'river') then raise exception 'Not a betting round'; end if;
  if (coalesce(st->'folded', '[]'::jsonb)) ? uid::text then raise exception 'You have folded'; end if;

  select _cc_cents(chip_counts) into stackc from lobby_players where lobby_id = p_lobby_id and user_id = uid;
  post := least(greatest(coalesce(p_cents, 0), 0), coalesce(stackc, 0));
  if post <= 0 then return; end if;

  update lobby_players set chip_counts = _poker_breakdown(p_lobby_id, stackc - post)
    where lobby_id = p_lobby_id and user_id = uid;
  st := jsonb_set(st, '{pot}', to_jsonb(coalesce((st->>'pot')::int, 0) + post));
  st := jsonb_set(st, '{contrib}',
    coalesce(st->'contrib', '{}'::jsonb) || jsonb_build_object(uid::text, coalesce((st->'contrib'->>uid::text)::int, 0) + post));
  st := jsonb_set(st, '{ready}', '[]'::jsonb);   -- a bet/raise reopens the round
  update lobbies set tracker_state = st where id = p_lobby_id;
end; $$;

-- Check/ready or fold. When everyone still in the hand is ready, advances the
-- street automatically (preflop->flop->turn->river->showdown). If only one
-- player is left, jumps straight to showdown for the dealer to award the pot.
create or replace function public.poker_act(p_lobby_id uuid, p_action text)
returns void language plpgsql security definer set search_path = public as $$
declare
  st jsonb; phase text; uid uuid := auth.uid();
  ids uuid[]; active uuid[]; ready uuid[]; folded uuid[]; next_phase text;
begin
  if not exists (select 1 from lobby_players where lobby_id = p_lobby_id and user_id = uid) then
    raise exception 'You are not in this room';
  end if;
  select tracker_state into st from lobbies where id = p_lobby_id for update;
  if st is null then raise exception 'No hand in progress'; end if;
  phase := st->>'phase';
  if phase not in ('preflop', 'flop', 'turn', 'river') then raise exception 'Not a betting round'; end if;

  select array_agg(value::uuid) into folded from jsonb_array_elements_text(coalesce(st->'folded', '[]'::jsonb));
  folded := coalesce(folded, '{}');
  select array_agg(value::uuid) into ready from jsonb_array_elements_text(coalesce(st->'ready', '[]'::jsonb));
  ready := coalesce(ready, '{}');

  if p_action = 'fold' and not (uid = any(folded)) then folded := folded || uid; end if;
  if not (uid = any(ready)) then ready := ready || uid; end if;

  select array_agg(user_id order by joined_at) into ids from lobby_players where lobby_id = p_lobby_id;
  select array_agg(x) into active from unnest(ids) x where not (x = any(folded));
  active := coalesce(active, '{}');

  st := jsonb_set(st, '{folded}', to_jsonb(folded));
  st := jsonb_set(st, '{ready}',  to_jsonb(ready));

  if coalesce(array_length(active, 1), 0) <= 1 then
    st := jsonb_set(st, '{phase}', to_jsonb('showdown'::text));
    st := jsonb_set(st, '{ready}', '[]'::jsonb);
  elsif (select count(*) from unnest(active) a where not (a = any(ready))) = 0 then
    next_phase := case phase
      when 'preflop' then 'flop'
      when 'flop'    then 'turn'
      when 'turn'    then 'river'
      else 'showdown' end;
    st := jsonb_set(st, '{phase}', to_jsonb(next_phase));
    st := jsonb_set(st, '{ready}', '[]'::jsonb);
  end if;

  update lobbies set tracker_state = st where id = p_lobby_id;
end; $$;

-- Host or dealer awards the pot to one or more winners (even split, odd cent to
-- the first), records it in the log, and resets to idle (button stays put).
create or replace function public.poker_award(p_lobby_id uuid, p_winners uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare
  v_host uuid; v_btn uuid; st jsonb; pot int; n int; share int; rem int;
  w uuid; i int := 0; add int; stackc int;
begin
  select host_id, dealer_id, tracker_state into v_host, v_btn, st from lobbies where id = p_lobby_id for update;
  if auth.uid() <> v_host and (v_btn is null or auth.uid() <> v_btn) then
    raise exception 'Only the host or dealer can award the pot';
  end if;
  if st is null then raise exception 'No hand in progress'; end if;
  pot := coalesce((st->>'pot')::int, 0);
  n := array_length(p_winners, 1);
  if n is null or n = 0 then raise exception 'Pick at least one winner'; end if;
  share := pot / n;
  rem := pot - share * n;

  foreach w in array p_winners loop
    i := i + 1;
    add := share + case when i = 1 then rem else 0 end;
    select _cc_cents(chip_counts) into stackc from lobby_players where lobby_id = p_lobby_id and user_id = w;
    update lobby_players set chip_counts = _poker_breakdown(p_lobby_id, coalesce(stackc, 0) + add)
      where lobby_id = p_lobby_id and user_id = w;
    if add > 0 then
      insert into chip_transfers (lobby_id, from_user, to_user, amount, note)
        values (p_lobby_id, w, w, add, 'pot');
    end if;
  end loop;

  st := jsonb_build_object(
    'variant', 'poker', 'phase', 'idle', 'pot', 0,
    'sb', coalesce((st->>'sb')::int, 0), 'bb', coalesce((st->>'bb')::int, 0), 'ante', coalesce((st->>'ante')::int, 0),
    'folded', '[]'::jsonb, 'ready', '[]'::jsonb, 'contrib', '{}'::jsonb
  );
  update lobbies set tracker_state = st where id = p_lobby_id;
end; $$;

revoke execute on function public.poker_set_blinds(uuid, integer, integer, integer) from public, anon;
revoke execute on function public.poker_new_hand(uuid, integer, integer, integer) from public, anon;
revoke execute on function public.poker_post(uuid, integer) from public, anon;
revoke execute on function public.poker_act(uuid, text) from public, anon;
revoke execute on function public.poker_award(uuid, uuid[]) from public, anon;
grant execute on function public.poker_set_blinds(uuid, integer, integer, integer) to authenticated;
grant execute on function public.poker_new_hand(uuid, integer, integer, integer) to authenticated;
grant execute on function public.poker_post(uuid, integer) to authenticated;
grant execute on function public.poker_act(uuid, text) to authenticated;
grant execute on function public.poker_award(uuid, uuid[]) to authenticated;
