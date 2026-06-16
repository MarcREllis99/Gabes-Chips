-- ============================================================
-- Blackjack tracker: dealer is the house bank (starts at $0, can go
-- negative), and payouts are reversible (Undo after Pay Out).
-- The dealer's net is stored in lobby_players.chips (cents, signed);
-- players keep their physical stacks in chip_counts.
-- ============================================================

-- Assign/clear the dealer; the dealer's stack resets to a $0 bank.
create or replace function public.set_dealer(p_lobby_id uuid, p_dealer_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (select 1 from lobby_players where lobby_id = p_lobby_id and user_id = auth.uid()) then
    raise exception 'You are not in this room';
  end if;
  if not exists (select 1 from lobby_players where lobby_id = p_lobby_id and user_id = p_dealer_id) then
    raise exception 'That player is not in this room';
  end if;
  update lobbies
    set dealer_id = p_dealer_id,
        tracker_state = jsonb_build_object('phase', 'idle', 'results', '{}'::jsonb, 'marked', '[]'::jsonb)
    where id = p_lobby_id;
  -- The dealer banks: net starts at $0, no physical stack
  update lobby_players set chips = 0, chip_counts = '{}'::jsonb
    where lobby_id = p_lobby_id and user_id = p_dealer_id;
end;
$$;
revoke execute on function public.set_dealer(uuid, uuid) from public, anon;
grant execute on function public.set_dealer(uuid, uuid) to authenticated;

-- Replace bj_commit with a richer version: also sets the dealer's net (chips)
-- and (for Undo) can restore per-player bets.
drop function if exists public.bj_commit(uuid, jsonb, boolean);
create or replace function public.bj_commit(
  p_lobby_id uuid,
  p_counts jsonb,
  p_clear_bets boolean default false,
  p_dealer_chips integer default null,
  p_bets jsonb default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_dealer uuid;
  r record;
begin
  select dealer_id into v_dealer from lobbies where id = p_lobby_id;
  if v_dealer is null or v_dealer <> auth.uid() then
    raise exception 'Only the dealer can run the hand';
  end if;

  for r in select key as pid, value as counts from jsonb_each(p_counts) loop
    update lobby_players set chip_counts = r.counts
    where lobby_id = p_lobby_id and user_id = r.pid::uuid;
  end loop;

  if p_dealer_chips is not null then
    update lobby_players set chips = p_dealer_chips
    where lobby_id = p_lobby_id and user_id = v_dealer;
  end if;

  if p_clear_bets then
    update lobby_players set bet_cents = 0 where lobby_id = p_lobby_id;
  end if;

  if p_bets is not null then
    for r in select key as pid, (value::int) as cents from jsonb_each_text(p_bets) loop
      update lobby_players set bet_cents = r.cents
      where lobby_id = p_lobby_id and user_id = r.pid::uuid;
    end loop;
  end if;
end;
$$;
revoke execute on function public.bj_commit(uuid, jsonb, boolean, integer, jsonb) from public, anon;
grant execute on function public.bj_commit(uuid, jsonb, boolean, integer, jsonb) to authenticated;
