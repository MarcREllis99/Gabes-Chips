export type Suit = "♠" | "♥" | "♦" | "♣";
export type CardRank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: CardRank;
  suit: Suit;
  display: string;
}

export interface HigherLowerRound {
  currentCard: Card;
  nextCard: Card | null;
  player1Guess: "higher" | "lower" | null;
  player2Guess: "higher" | "lower" | null;
  player1Bet: number;
  player2Bet: number;
  roundWinner: string | null;
}

export interface HigherLowerState {
  phase: "betting" | "guessing" | "reveal" | "finished";
  rounds: HigherLowerRound[];
  currentRound: number;
  totalRounds: number;
  player1Id: string;
  player2Id: string;
  player1Score: number;
  player2Score: number;
  player1Chips: number;
  player2Chips: number;
  deck: Card[];
  winnerId: string | null;
  pot: number;
}

export const HOUSE_RAKE = 0; // no house rake — winners take the full pot
const SUITS: Suit[] = ["♠", "♥", "♦", "♣"];
const RANK_DISPLAY: Record<CardRank, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8",
  9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A",
};

export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank++) {
      const r = rank as CardRank;
      deck.push({ rank: r, suit, display: RANK_DISPLAY[r] });
    }
  }
  return shuffle(deck);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function initHigherLowerState(
  player1Id: string,
  player2Id: string,
  stake: number
): HigherLowerState {
  const deck = buildDeck();
  const firstCard = deck.pop()!;
  return {
    phase: "betting",
    rounds: [{
      currentCard: firstCard,
      nextCard: null,
      player1Guess: null,
      player2Guess: null,
      player1Bet: 0,
      player2Bet: 0,
      roundWinner: null,
    }],
    currentRound: 0,
    totalRounds: 5,
    player1Id,
    player2Id,
    player1Score: 0,
    player2Score: 0,
    player1Chips: stake,
    player2Chips: stake,
    deck,
    winnerId: null,
    pot: stake * 2,
  };
}

export function resolveRound(
  state: HigherLowerState
): HigherLowerState {
  const round = state.rounds[state.currentRound];
  const nextCard = state.deck[state.deck.length - 1];
  const isHigher = nextCard.rank > round.currentCard.rank;
  const isTie = nextCard.rank === round.currentCard.rank;

  let p1Wins = false;
  let p2Wins = false;

  if (!isTie) {
    p1Wins = (round.player1Guess === "higher") === isHigher;
    p2Wins = (round.player2Guess === "higher") === isHigher;
  }

  let roundWinner: string | null = null;
  let newP1Score = state.player1Score;
  let newP2Score = state.player2Score;

  if (p1Wins && !p2Wins) {
    roundWinner = state.player1Id;
    newP1Score++;
  } else if (p2Wins && !p1Wins) {
    roundWinner = state.player2Id;
    newP2Score++;
  }

  const updatedRound: HigherLowerRound = {
    ...round,
    nextCard,
    roundWinner,
  };

  const newDeck = state.deck.slice(0, -1);
  const isLastRound = state.currentRound >= state.totalRounds - 1;

  let winnerId: string | null = null;
  let nextRounds = [...state.rounds];
  nextRounds[state.currentRound] = updatedRound;

  if (!isLastRound) {
    const nextCardForNewRound = newDeck.pop()!;
    nextRounds.push({
      currentCard: nextCard,
      nextCard: null,
      player1Guess: null,
      player2Guess: null,
      player1Bet: 0,
      player2Bet: 0,
      roundWinner: null,
    });
    // Actually use the popped card as the current card for next round
    nextRounds[state.currentRound + 1] = {
      ...nextRounds[state.currentRound + 1],
      currentCard: nextCard,
    };
  } else {
    if (newP1Score > newP2Score) winnerId = state.player1Id;
    else if (newP2Score > newP1Score) winnerId = state.player2Id;
    // Tie — house takes all (or split, we'll give to host)
    else winnerId = state.player1Id;
  }

  return {
    ...state,
    rounds: nextRounds,
    currentRound: isLastRound ? state.currentRound : state.currentRound + 1,
    player1Score: newP1Score,
    player2Score: newP2Score,
    deck: newDeck,
    phase: isLastRound ? "finished" : "betting",
    winnerId,
  };
}

export function calculatePayout(state: HigherLowerState): number {
  return Math.floor(state.pot * (1 - HOUSE_RAKE));
}
