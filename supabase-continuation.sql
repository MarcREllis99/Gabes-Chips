-- ============================================================
-- Cross-game continuation
-- After a game finishes the lobby stays alive. The host can start
-- another game of ANY type with the same group — chips carry because
-- chip_balance is a single global bank.
--
-- reset_lobby(): host-only; returns a finished lobby to 'waiting' and
-- (optionally) switches the game type, so the normal start flow + dealer
-- roulette can run again for the next game.
-- ============================================================

-- Reserved for the upcoming mid-game "settle the pot in another game"
-- feature; unused for now.
alter table public.lobbies
  add column if not exists carry_pot integer not null default 0;

create or replace function public.reset_lobby(
  p_lobby_id uuid,
  p_game_type text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_lobby lobbies%rowtype;
begin
  select * into v_lobby from lobbies where id = p_lobby_id;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_id <> auth.uid() then raise exception 'Only the host can start another game'; end if;

  update lobbies
  set status = 'waiting',
      game_type = p_game_type,
      dealer_id = null,
      carry_pot = 0
  where id = p_lobby_id;
end;
$$;

revoke execute on function public.reset_lobby(uuid, text) from public, anon;
grant execute on function public.reset_lobby(uuid, text) to authenticated;
