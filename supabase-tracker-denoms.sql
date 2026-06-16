-- ============================================================
-- Chip Tracker: per-denomination chip holdings (poker/blackjack felt view).
-- Each player holds a count of each chip denomination so chips can be shown
-- color-coded and sent individually. Transfers move specific denominations.
-- Blackjack: only the dealer (lobbies.dealer_id) may move chips, and a move
-- must involve the dealer (give to / take from a player).
-- ============================================================

alter table public.lobby_players
  add column if not exists chip_counts jsonb;

-- p_counts: { "<denomValue>": <count>, ... }  e.g. {"0.25": 3, "1": 2}
create or replace function public.transfer_chip_denoms(
  p_lobby_id uuid,
  p_from uuid,
  p_to uuid,
  p_counts jsonb
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_dealer uuid;
  v_from jsonb;
  v_to jsonb;
  r record;
  v_total_cents integer := 0;
begin
  if p_from = p_to then raise exception 'Pick a different player'; end if;

  select dealer_id into v_dealer from lobbies where id = p_lobby_id;
  if not exists (select 1 from lobby_players where lobby_id = p_lobby_id and user_id = p_from) then
    raise exception 'Sender is not in this room';
  end if;
  if not exists (select 1 from lobby_players where lobby_id = p_lobby_id and user_id = p_to) then
    raise exception 'Recipient is not in this room';
  end if;

  -- Blackjack (dealer set): only the dealer transacts, and the dealer is one side.
  if v_dealer is not null then
    if v_caller <> v_dealer then raise exception 'Only the dealer can move chips'; end if;
    if p_from <> v_dealer and p_to <> v_dealer then raise exception 'A transfer must involve the dealer'; end if;
  else
    if p_from <> v_caller then raise exception 'You can only send your own chips'; end if;
  end if;

  select coalesce(chip_counts, '{}'::jsonb) into v_from from lobby_players where lobby_id = p_lobby_id and user_id = p_from;
  select coalesce(chip_counts, '{}'::jsonb) into v_to from lobby_players where lobby_id = p_lobby_id and user_id = p_to;

  for r in select key, (value::int) as cnt from jsonb_each_text(p_counts) loop
    if r.cnt <= 0 then continue; end if;
    if coalesce((v_from->>r.key)::int, 0) < r.cnt then raise exception 'Not enough chips of one denomination'; end if;
    v_from := jsonb_set(v_from, array[r.key], to_jsonb(coalesce((v_from->>r.key)::int, 0) - r.cnt));
    v_to := jsonb_set(v_to, array[r.key], to_jsonb(coalesce((v_to->>r.key)::int, 0) + r.cnt));
    v_total_cents := v_total_cents + round(r.key::numeric * 100)::int * r.cnt;
  end loop;

  if v_total_cents <= 0 then raise exception 'No chips selected'; end if;

  update lobby_players set chip_counts = v_from where lobby_id = p_lobby_id and user_id = p_from;
  update lobby_players set chip_counts = v_to where lobby_id = p_lobby_id and user_id = p_to;

  insert into chip_transfers (lobby_id, from_user, to_user, amount)
  values (p_lobby_id, p_from, p_to, v_total_cents);
end;
$$;

revoke execute on function public.transfer_chip_denoms(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.transfer_chip_denoms(uuid, uuid, uuid, jsonb) to authenticated;
