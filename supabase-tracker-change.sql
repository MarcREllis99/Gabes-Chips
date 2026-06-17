-- ============================================================
-- Chip Tracker — players make change on their own stack.
-- recount_chips lets a player re-express their chips into different
-- denominations (e.g. break a $5 into five $1s) WITHOUT changing the total
-- value. Guards: same total value, room denominations only, no negatives.
-- ============================================================

create or replace function public.recount_chips(p_lobby_id uuid, p_counts jsonb)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_cur integer;
  v_new integer;
  v_cfg jsonb;
  uid uuid := auth.uid();
begin
  if not exists (select 1 from lobby_players where lobby_id = p_lobby_id and user_id = uid) then
    raise exception 'You are not in this room';
  end if;

  -- no negative counts
  if exists (
    select 1 from jsonb_each_text(coalesce(p_counts, '{}'::jsonb)) e(key, value)
    where (value::integer) < 0
  ) then
    raise exception 'Counts cannot be negative';
  end if;

  -- current value (cents) of the caller's chips
  select coalesce(sum(round((e.key)::numeric * 100) * (e.value::integer)), 0)::int into v_cur
  from lobby_players lp, jsonb_each_text(coalesce(lp.chip_counts, '{}'::jsonb)) e(key, value)
  where lp.lobby_id = p_lobby_id and lp.user_id = uid;

  -- proposed value (cents)
  select coalesce(sum(round((e.key)::numeric * 100) * (e.value::integer)), 0)::int into v_new
  from jsonb_each_text(coalesce(p_counts, '{}'::jsonb)) e(key, value);

  if v_new <> v_cur then
    raise exception 'Making change must keep the same total value';
  end if;

  -- only denominations configured for this room are allowed
  select tracker_config into v_cfg from lobbies where id = p_lobby_id;
  if exists (
    select 1 from jsonb_each_text(coalesce(p_counts, '{}'::jsonb)) e(key, value)
    where (e.value::integer) > 0
      and (e.key)::numeric not in (
        select (d->>'value')::numeric from jsonb_array_elements(coalesce(v_cfg->'denominations', '[]'::jsonb)) d
      )
  ) then
    raise exception 'Unknown chip denomination';
  end if;

  update lobby_players set chip_counts = p_counts where lobby_id = p_lobby_id and user_id = uid;
end;
$$;

revoke execute on function public.recount_chips(uuid, jsonb) from public, anon;
grant execute on function public.recount_chips(uuid, jsonb) to authenticated;
