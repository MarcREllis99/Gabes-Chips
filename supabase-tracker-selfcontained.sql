-- ============================================================
-- Make the Chip Tracker a self-contained per-room ledger.
-- Denomination (poker/blackjack) rooms track real money in CENTS, so we
-- must NOT add that into profiles.chip_balance (the abstract in-app chip
-- leaderboard) — mixing dollars and chips would be meaningless. Transfers
-- now move only the per-room stack.
-- ============================================================

create or replace function public.transfer_chips(
  p_lobby_id uuid,
  p_to uuid,
  p_amount integer
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_from uuid := auth.uid();
begin
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if p_to = v_from then raise exception 'You can''t send chips to yourself'; end if;
  if not exists (select 1 from lobby_players where lobby_id = p_lobby_id and user_id = v_from) then
    raise exception 'You are not in this room';
  end if;
  if not exists (select 1 from lobby_players where lobby_id = p_lobby_id and user_id = p_to) then
    raise exception 'That player is not in this room';
  end if;

  update lobby_players set chips = chips - p_amount where lobby_id = p_lobby_id and user_id = v_from;
  update lobby_players set chips = chips + p_amount where lobby_id = p_lobby_id and user_id = p_to;

  insert into chip_transfers (lobby_id, from_user, to_user, amount)
  values (p_lobby_id, v_from, p_to, p_amount);
end;
$$;
