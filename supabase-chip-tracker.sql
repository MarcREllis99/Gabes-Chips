-- ============================================================
-- Chip Tracker — use the app as a chip ledger for real-life card games.
-- A tracker is a lobby (game_type 'chip_tracker', status 'tracking'); members
-- send each other chips, moving their global chip_balance. Zero-sum, no
-- minting — it feeds the same ledger/leaderboard as the in-app games.
-- ============================================================

-- 1. Allow the new game type + lobby status
alter table public.lobbies drop constraint if exists lobbies_game_type_check;
alter table public.lobbies add constraint lobbies_game_type_check
  check (game_type in ('coin_flip','higher_lower','blackjack','texas_holdem','three_card','free_bet','euchre','gabes_wilds','war','chip_tracker'));

alter table public.lobbies drop constraint if exists lobbies_status_check;
alter table public.lobbies add constraint lobbies_status_check
  check (status in ('waiting','active','finished','tracking'));

-- 2. Transfer history
create table if not exists public.chip_transfers (
  id uuid default gen_random_uuid() primary key,
  lobby_id uuid references public.lobbies(id) on delete cascade not null,
  from_user uuid references public.profiles(id) not null,
  to_user uuid references public.profiles(id) not null,
  amount integer not null check (amount > 0),
  created_at timestamptz default now() not null
);
create index if not exists chip_transfers_lobby_idx on public.chip_transfers(lobby_id);

alter table public.chip_transfers enable row level security;

-- Members of the room can read its transfer log
drop policy if exists "members read transfers" on public.chip_transfers;
create policy "members read transfers" on public.chip_transfers for select to authenticated using (
  exists (
    select 1 from public.lobby_players
    where lobby_id = chip_transfers.lobby_id and user_id = auth.uid()
  )
);
-- No insert policy: rows are written only by the SECURITY DEFINER RPC below.

-- 3. Send chips to another member (caller is the sender).
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

  -- Net ledger: balances may go negative (it tracks who's up and who's down)
  update profiles set chip_balance = chip_balance - p_amount where id = v_from;
  update profiles set chip_balance = chip_balance + p_amount where id = p_to;

  insert into chip_transfers (lobby_id, from_user, to_user, amount)
  values (p_lobby_id, v_from, p_to, p_amount);
end;
$$;

revoke execute on function public.transfer_chips(uuid, uuid, integer) from public, anon;
grant execute on function public.transfer_chips(uuid, uuid, integer) to authenticated;
