-- ============================================================
-- Gabe's Wilds — shedding card game (2–8 players)
-- Just needs to be an allowed game type. It antes like the pot games
-- and pays a single winner via the existing finish_game RPC, so no
-- new functions are required (start_game's default minimum of 2 applies).
-- ============================================================

alter table public.lobbies drop constraint if exists lobbies_game_type_check;
alter table public.lobbies add constraint lobbies_game_type_check
  check (game_type in ('coin_flip','higher_lower','blackjack','texas_holdem','three_card','free_bet','euchre','gabes_wilds'));

alter table public.games drop constraint if exists games_game_type_check;
alter table public.games add constraint games_game_type_check
  check (game_type in ('coin_flip','higher_lower','blackjack','texas_holdem','three_card','free_bet','euchre','gabes_wilds'));
