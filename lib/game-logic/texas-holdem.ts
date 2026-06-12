import {
  type PCard,
  buildDeck,
  best7,
  compareScores,
  HAND_NAMES,
} from "./poker";

export type { PCard };

export interface HoldemPlayer {
  playerId: string;
  hole: PCard[];
}

export interface HoldemState {
  phase: "preflop" | "flop" | "turn" | "river" | "showdown";
  stake: number;
  pot: number;
  players: HoldemPlayer[];
  board: PCard[];
  deck: PCard[];
  winnerId: string | null;
  winnerHandName: string | null;
  // Each player's best-hand score + readable name, filled at showdown
  showdown: Record<string, { score: number[]; name: string }> | null;
}

export const HOUSE_RAKE = 0.05;

// Everyone antes the stake up front — the whole game is one run-out
// (no betting rounds): deal, board, showdown, best hand takes the pot.
export function initHoldemState(playerIds: string[], stake: number): HoldemState {
  const deck = buildDeck();
  const players: HoldemPlayer[] = playerIds.map((playerId) => ({
    playerId,
    hole: [deck.pop()!, deck.pop()!],
  }));

  return {
    phase: "preflop",
    stake,
    pot: stake * playerIds.length,
    players,
    board: [],
    deck,
    winnerId: null,
    winnerHandName: null,
    showdown: null,
  };
}

export const NEXT_STREET_LABEL: Record<HoldemState["phase"], string> = {
  preflop: "Deal the Flop",
  flop: "Deal the Turn",
  turn: "Deal the River",
  river: "Showdown",
  showdown: "",
};

export function advanceStreet(state: HoldemState): HoldemState {
  const deck = [...state.deck];
  const board = [...state.board];

  switch (state.phase) {
    case "preflop":
      board.push(deck.pop()!, deck.pop()!, deck.pop()!);
      return { ...state, deck, board, phase: "flop" };
    case "flop":
      board.push(deck.pop()!);
      return { ...state, deck, board, phase: "turn" };
    case "turn":
      board.push(deck.pop()!);
      return { ...state, deck, board, phase: "river" };
    case "river": {
      const showdown: HoldemState["showdown"] = {};
      let winnerId: string | null = null;
      let bestScore: number[] | null = null;

      // Seat order breaks exact ties (host first)
      for (const p of state.players) {
        const score = best7([...p.hole, ...board]);
        showdown[p.playerId] = { score, name: HAND_NAMES[score[0]] };
        if (!bestScore || compareScores(score, bestScore) > 0) {
          bestScore = score;
          winnerId = p.playerId;
        }
      }

      return {
        ...state,
        phase: "showdown",
        showdown,
        winnerId,
        winnerHandName: winnerId ? showdown[winnerId].name : null,
      };
    }
    default:
      return state;
  }
}

export function holdemPayout(pot: number): number {
  return Math.floor(pot * (1 - HOUSE_RAKE));
}
