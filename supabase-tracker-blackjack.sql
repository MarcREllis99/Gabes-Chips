-- ============================================================
-- Chip Tracker — Blackjack hand flow.
-- Players place bets (lobby_players.bet_cents); the dealer runs the hand
-- via lobbies.tracker_state {phase, results}. Chip math is computed on the
-- dealer's client and persisted with bj_commit (dealer-authorized), which
-- sets multiple players' chip_counts at once and can clear all bets.
-- ============================================================

alter table public.lobby_players add column if not exists bet_cents integer not null default 0;
alter table public.lobbies add column if not exists tracker_state jsonb;

-- A player sets their own bet (during the betting phase)
create or replace function public.place_bet(p_lobby_id uuid, p_cents integer)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (select 1 from lobby_players where lobby_id = p_lobby_id and user_id = auth.uid()) then
    raise exception 'You are not in this room';
  end if;
  update lobby_players set bet_cents = greatest(0, coalesce(p_cents, 0))
  where lobby_id = p_lobby_id and user_id = auth.uid();
end;
$$;

revoke execute on function public.place_bet(uuid, integer) from public, anon;
grant execute on function public.place_bet(uuid, integer) to authenticated;

-- Dealer persists new chip stacks (and optionally clears all bets).
-- p_counts: { "<player uuid>": { "<denom>": count, ... }, ... }
create or replace function public.bj_commit(p_lobby_id uuid, p_counts jsonb, p_clear_bets boolean default false)
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

  if p_clear_bets then
    update lobby_players set bet_cents = 0 where lobby_id = p_lobby_id;
  end if;
end;
$$;

revoke execute on function public.bj_commit(uuid, jsonb, boolean) from public, anon;
grant execute on function public.bj_commit(uuid, jsonb, boolean) to authenticated;
