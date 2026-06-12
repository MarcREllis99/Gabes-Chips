-- Lobbies now remember which game was chosen when the lobby was
-- created (game selection moved from the lobby to the home page).
-- Existing lobbies default to coin_flip.

alter table public.lobbies
  add column if not exists game_type text not null default 'coin_flip'
  check (game_type in ('coin_flip', 'higher_lower', 'blackjack'));
