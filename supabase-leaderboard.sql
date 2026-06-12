-- ============================================================
-- Leaderboard / ledger stats
-- 1. leaderboard_stats(): every player's net chip position,
--    games played, and recorded wins
-- 2. recent_games_feed(): the latest finished games with stake,
--    winner (null for house games with per-player outcomes),
--    and player count
-- ============================================================

create or replace function public.leaderboard_stats()
returns table (
  id uuid,
  username text,
  chip_balance integer,
  games_played bigint,
  wins bigint
)
language sql
security definer set search_path = public
as $$
  select
    p.id,
    p.username,
    p.chip_balance,
    (
      select count(distinct g.id)
      from lobby_players lp
      join games g on g.lobby_id = lp.lobby_id
      join lobbies l on l.id = lp.lobby_id
      where lp.user_id = p.id and l.status = 'finished'
    ) as games_played,
    (select count(*) from games g where g.winner_id = p.id) as wins
  from profiles p
  order by p.chip_balance desc, p.username asc;
$$;

revoke execute on function public.leaderboard_stats() from public, anon;
grant execute on function public.leaderboard_stats() to authenticated;

create or replace function public.recent_games_feed(p_limit integer default 20)
returns table (
  game_id uuid,
  game_type text,
  stake integer,
  winner_username text,
  player_count bigint,
  created_at timestamptz
)
language sql
security definer set search_path = public
as $$
  select
    g.id,
    g.game_type,
    coalesce((g.state->>'stake')::integer, 0) as stake,
    w.username as winner_username,
    (select count(*) from lobby_players lp where lp.lobby_id = g.lobby_id) as player_count,
    g.created_at
  from games g
  join lobbies l on l.id = g.lobby_id
  left join profiles w on w.id = g.winner_id
  where l.status = 'finished'
  order by g.created_at desc
  limit least(coalesce(p_limit, 20), 50);
$$;

revoke execute on function public.recent_games_feed(integer) from public, anon;
grant execute on function public.recent_games_feed(integer) to authenticated;
