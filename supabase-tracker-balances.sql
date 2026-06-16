-- ============================================================
-- Per-room chip balances for the Chip Tracker.
-- Each player gets a fresh stack (the buy-in) inside a tracker room, so
-- opening a new room is a clean slate — your accumulated all-time total
-- (profiles.chip_balance, shown on the leaderboard) is separate.
-- Transfers move BOTH the room stack and the all-time total.
-- ============================================================

alter table public.lobby_players
  add column if not exists chips integer not null default 0;

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

  -- Room stack (what the tracker shows): starts at the buy-in, moves here
  update lobby_players set chips = chips - p_amount where lobby_id = p_lobby_id and user_id = v_from;
  update lobby_players set chips = chips + p_amount where lobby_id = p_lobby_id and user_id = p_to;

  -- All-time net (the leaderboard): real wins/losses accumulate forever
  update profiles set chip_balance = chip_balance - p_amount where id = v_from;
  update profiles set chip_balance = chip_balance + p_amount where id = p_to;

  insert into chip_transfers (lobby_id, from_user, to_user, amount)
  values (p_lobby_id, v_from, p_to, p_amount);
end;
$$;
