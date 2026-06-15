-- ============================================================
-- War — 1v1 luck card game
-- Just needs to be an allowed game type; antes like the other pot
-- games and pays a single winner via finish_game (start_game's default
-- minimum of 2 applies, and the lobby is capped at 2 players).
-- ============================================================

alter table public.lobbies drop constraint if exists lobbies_game_type_check;
alter table public.lobbies add constraint lobbies_game_type_check
  check (game_type in ('coin_flip','higher_lower','blackjack','texas_holdem','three_card','free_bet','euchre','gabes_wilds','war'));

alter table public.games drop constraint if exists games_game_type_check;
alter table public.games add constraint games_game_type_check
  check (game_type in ('coin_flip','higher_lower','blackjack','texas_holdem','three_card','free_bet','euchre','gabes_wilds','war'));
