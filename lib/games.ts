export type GameType =
  | "coin_flip"
  | "higher_lower"
  | "blackjack"
  | "texas_holdem"
  | "three_card"
  | "free_bet"
  | "euchre"
  | "gabes_wilds";

export interface GameInfo {
  name: string;
  emoji: string;
  desc: string;
  limit: string;
  minPlayers: number;
  maxPlayers: number;
}

export const GAME_INFO: Record<GameType, GameInfo> = {
  coin_flip: {
    name: "Coin Flip",
    emoji: "🪙",
    desc: "Call the toss — winner takes the pot.",
    limit: "2 players",
    minPlayers: 2,
    maxPlayers: 2,
  },
  higher_lower: {
    name: "Higher or Lower",
    emoji: "🃏",
    desc: "Guess if the next card is higher or lower, over 5 rounds.",
    limit: "2 players",
    minPlayers: 2,
    maxPlayers: 2,
  },
  blackjack: {
    name: "Blackjack",
    emoji: "🂱",
    desc: "Beat the dealer — closest to 21 without busting.",
    limit: "1–7 players vs the house",
    minPlayers: 1,
    maxPlayers: 7,
  },
  texas_holdem: {
    name: "Texas Hold'em",
    emoji: "♠️",
    desc: "Two hole cards, five on the board — best hand takes the pot.",
    limit: "2–7 players",
    minPlayers: 2,
    maxPlayers: 7,
  },
  three_card: {
    name: "3 Card Poker",
    emoji: "🎴",
    desc: "Three cards each — play or fold against the dealer's hand.",
    limit: "1–7 players vs the house",
    minPlayers: 1,
    maxPlayers: 7,
  },
  free_bet: {
    name: "Free Bet Blackjack",
    emoji: "🎰",
    desc: "Blackjack with free double downs — but dealer 22 pushes.",
    limit: "1–7 players vs the house",
    minPlayers: 1,
    maxPlayers: 7,
  },
  euchre: {
    name: "Euchre",
    emoji: "🃏",
    desc: "Classic 2-on-2 trick game with bowers — first team to 10 wins.",
    limit: "4 players (2 teams)",
    minPlayers: 4,
    maxPlayers: 4,
  },
  gabes_wilds: {
    name: "Gabe's Wilds",
    emoji: "🌈",
    desc: "Match by color or number, sling skips & wilds — first to empty their hand takes the pot.",
    limit: "2–8 players",
    minPlayers: 2,
    maxPlayers: 8,
  },
};

export const GAME_LIST = (
  Object.entries(GAME_INFO) as [GameType, GameInfo][]
).map(([id, info]) => ({ id, ...info }));
