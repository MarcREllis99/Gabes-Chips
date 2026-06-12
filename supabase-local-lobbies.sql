-- ============================================================
-- "On your WiFi" lobby discovery via public-IP matching
--
-- Devices on the same WiFi share one public IP (the router's).
-- We capture the host's IP when a lobby is created and compare
-- it server-side with the viewer's IP. Clients only ever see a
-- true/false flag — IP addresses never leave the database.
--
-- Known limits (accepted): VPNs and phones on cellular data show
-- as not-local; carrier-grade NAT can rarely flag a stranger on
-- the same ISP as local; IPv6 privacy addresses may not match.
-- ============================================================

-- 1. Private side-table for host IPs.
--    RLS enabled with NO policies = invisible to all clients.
create table if not exists public.lobby_network (
  lobby_id uuid primary key references public.lobbies(id) on delete cascade,
  host_ip text
);

alter table public.lobby_network enable row level security;

-- 2. Capture the creator's public IP whenever a lobby is created.
--    PostgREST exposes request headers to Postgres; the first entry
--    of x-forwarded-for is the client's public IP.
create or replace function public.capture_lobby_ip()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into lobby_network (lobby_id, host_ip)
  values (
    new.id,
    trim(split_part(
      coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''),
      ',', 1
    ))
  )
  on conflict (lobby_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_lobby_created_capture_ip on public.lobbies;
create trigger on_lobby_created_capture_ip
  after insert on public.lobbies
  for each row execute procedure public.capture_lobby_ip();

-- 3. Open-lobby list with an on_my_network flag, computed server-side.
--    Also returns player_count + host_username so the home page can
--    load everything in one call.
create or replace function public.open_lobbies_with_network()
returns table (
  id uuid,
  name text,
  code text,
  host_id uuid,
  status text,
  max_players integer,
  buy_in integer,
  game_type text,
  created_at timestamptz,
  player_count bigint,
  host_username text,
  on_my_network boolean
)
language sql
security definer set search_path = public
as $$
  select
    l.id, l.name, l.code, l.host_id, l.status,
    l.max_players, l.buy_in, l.game_type, l.created_at,
    (select count(*) from lobby_players lp where lp.lobby_id = l.id) as player_count,
    p.username as host_username,
    coalesce(
      ln.host_ip <> ''
      and ln.host_ip = trim(split_part(
        coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''),
        ',', 1
      )),
      false
    ) as on_my_network
  from lobbies l
  join profiles p on p.id = l.host_id
  left join lobby_network ln on ln.lobby_id = l.id
  where l.status = 'waiting'
  order by l.created_at desc;
$$;

-- Only signed-in users may call it (same as the lobby list itself)
revoke execute on function public.open_lobbies_with_network() from public, anon;
grant execute on function public.open_lobbies_with_network() to authenticated;
