-- Disband a lobby: refunds every joined player's buy-in, then deletes
-- the lobby (lobby_players and games rows cascade-delete automatically).
-- SECURITY DEFINER lets it update other players' chip balances, which
-- normal RLS policies would block. Only the host may call it.

create or replace function public.disband_lobby(p_lobby_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_lobby lobbies%rowtype;
begin
  select * into v_lobby from lobbies where id = p_lobby_id;

  if not found then
    raise exception 'Lobby not found';
  end if;

  if v_lobby.host_id <> auth.uid() then
    raise exception 'Only the host can disband the lobby';
  end if;

  -- Refund buy-ins only if the game never started
  if v_lobby.status = 'waiting' then
    update profiles
    set chip_balance = chip_balance + v_lobby.buy_in
    where id in (
      select user_id from lobby_players where lobby_id = p_lobby_id
    );
  end if;

  delete from lobbies where id = p_lobby_id;
end;
$$;
