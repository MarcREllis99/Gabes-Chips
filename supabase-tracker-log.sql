-- ============================================================
-- Record blackjack hand outcomes in the transfer log.
-- Adds chip_transfers.note (e.g. "won" / "lost" / "blackjack") and lets
-- bj_commit insert a batch of log rows at payout.
-- ============================================================

alter table public.chip_transfers add column if not exists note text;

drop function if exists public.bj_commit(uuid, jsonb, boolean, integer, jsonb);
create or replace function public.bj_commit(
  p_lobby_id uuid,
  p_counts jsonb,
  p_clear_bets boolean default false,
  p_dealer_chips integer default null,
  p_bets jsonb default null,
  p_log jsonb default null
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

  if p_log is not null then
    for r in select * from jsonb_to_recordset(p_log) as x(from_user uuid, to_user uuid, amount integer, note text) loop
      insert into chip_transfers (lobby_id, from_user, to_user, amount, note)
      values (p_lobby_id, r.from_user, r.to_user, r.amount, r.note);
    end loop;
  end if;
end;
$$;

revoke execute on function public.bj_commit(uuid, jsonb, boolean, integer, jsonb, jsonb) from public, anon;
grant execute on function public.bj_commit(uuid, jsonb, boolean, integer, jsonb, jsonb) to authenticated;

-- Remove the most recent N log rows (used when the dealer undoes a payout).
create or replace function public.bj_delete_recent_log(p_lobby_id uuid, p_count integer)
returns void
language plpgsql
security definer set search_path = public
as $$
declare v_dealer uuid;
begin
  select dealer_id into v_dealer from lobbies where id = p_lobby_id;
  if v_dealer is null or v_dealer <> auth.uid() then
    raise exception 'Only the dealer can do this';
  end if;
  if p_count is null or p_count <= 0 then return; end if;
  delete from chip_transfers where id in (
    select id from chip_transfers where lobby_id = p_lobby_id order by created_at desc limit p_count
  );
end;
$$;
revoke execute on function public.bj_delete_recent_log(uuid, integer) from public, anon;
grant execute on function public.bj_delete_recent_log(uuid, integer) to authenticated;
