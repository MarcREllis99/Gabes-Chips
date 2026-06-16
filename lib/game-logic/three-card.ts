import {
  type PCard,
  buildDeck,
  evaluate3,
  compareScores,
  dealerQualifies3,
  HAND_NAMES_3,
} from "./poker";

export type { PCard };
export { HAND_NAMES_3 };

// Outcome keys map to payout multipliers:
// "blackjack" = 2.5x return — used as the straight-or-better bonus.
export type ThreeCardOutcome = "win" | "lose" | "push" | "blackjack";

export interface ThreeCardPlayer {
  playerId: string;
  hand: PCard[];
  decision: "play" | "fold" | null;
}

// Multi-round bankroll table vs the house. Each round players choose an ante
// from their stack, then play or fold. Players are eliminated at $0 and the
// game ends when one player is left standing.
export interface ThreeCardState {
  phase: "betting" | "deciding" | "reveal" | "result";
  stake: number;                    // buy-in (reference)
  round: number;
  playerIds: string[];
  stacks: Record<string, number>;
  antes: Record<string, number>;    // this round's ante (escrowed)
  players: ThreeCardPlayer[];       // only players who anted this round
  dealerHand: PCard[];
  dealerRevealed: boolean;
  dealerQualified: boolean | null;
  deck: PCard[];
  results: Record<string, ThreeCardOutcome> | null;
  ended: boolean;
}

export function initThreeCardTable(playerIds: string[], buyIn: number): ThreeCardState {
  const stacks: Record<string, number> = {};
  for (const id of playerIds) stacks[id] = buyIn;
  return {
    phase: "betting", stake: buyIn, round: 1, playerIds, stacks, antes: {},
    players: [], dealerHand: [], dealerRevealed: false, dealerQualified: null,
    deck: [], results: null, ended: false,
  };
}

export function setAnte(state: ThreeCardState, playerId: string, amount: number): ThreeCardState {
  if (state.phase !== "betting") return state;
  const current = state.antes[playerId] ?? 0;
  const pool = (state.stacks[playerId] ?? 0) + current;
  const ante = Math.max(0, Math.min(Math.floor(amount), pool));
  return {
    ...state,
    stacks: { ...state.stacks, [playerId]: pool - ante },
    antes: { ...state.antes, [playerId]: ante },
  };
}

export function anyAnte(state: ThreeCardState): boolean {
  return state.playerIds.some((id) => (state.antes[id] ?? 0) > 0);
}

export function dealThreeCard(state: ThreeCardState): ThreeCardState {
  const bettors = state.playerIds.filter((id) => (state.antes[id] ?? 0) > 0);
  const deck = buildDeck();
  const players: ThreeCardPlayer[] = bettors.map((playerId) => ({
    playerId,
    hand: [deck.pop()!, deck.pop()!, deck.pop()!],
    decision: null,
  }));
  const dealerHand = [deck.pop()!, deck.pop()!, deck.pop()!];
  return { ...state, phase: "deciding", deck, players, dealerHand, dealerRevealed: false, dealerQualified: null, results: null };
}

export function decide(state: ThreeCardState, playerId: string, decision: "play" | "fold"): ThreeCardState {
  return {
    ...state,
    players: state.players.map((p) =>
      p.playerId === playerId && p.decision === null ? { ...p, decision } : p
    ),
  };
}

export function allDecided(state: ThreeCardState): boolean {
  return state.players.length > 0 && state.players.every((p) => p.decision !== null);
}

export function revealDealer3(state: ThreeCardState): ThreeCardState {
  return { ...state, phase: "reveal", dealerRevealed: true };
}

export function resolveThreeCard(state: ThreeCardState): ThreeCardState {
  const dealerScore = evaluate3(state.dealerHand);
  const qualified = dealerQualifies3(dealerScore);

  const results: Record<string, ThreeCardOutcome> = {};
  const stacks = { ...state.stacks };

  for (const p of state.players) {
    let outcome: ThreeCardOutcome;
    if (p.decision === "fold") {
      outcome = "lose";
    } else {
      const score = evaluate3(p.hand);
      const bonus = score[0] >= 3; // straight or better pays the bonus
      if (!qualified) outcome = bonus ? "blackjack" : "win";
      else {
        const cmp = compareScores(score, dealerScore);
        if (cmp > 0) outcome = bonus ? "blackjack" : "win";
        else if (cmp < 0) outcome = "lose";
        else outcome = "push";
      }
    }
    results[p.playerId] = outcome;
    const ante = state.antes[p.playerId] ?? 0;
    stacks[p.playerId] = (stacks[p.playerId] ?? 0) + threeCardPayout(outcome, ante);
  }

  return { ...state, phase: "result", dealerRevealed: true, dealerQualified: qualified, results, stacks };
}

export function nextRound(state: ThreeCardState): ThreeCardState {
  return {
    ...state, phase: "betting", round: state.round + 1, antes: {},
    players: [], dealerHand: [], dealerRevealed: false, dealerQualified: null, results: null,
  };
}

// Chips returned to the player (the ante was escrowed out of their stack).
export function threeCardPayout(outcome: ThreeCardOutcome, ante: number): number {
  switch (outcome) {
    case "blackjack": return ante + Math.floor(ante * 1.5);
    case "win": return ante * 2;
    case "push": return ante;
    case "lose": return 0;
  }
}

export function handName3(hand: PCard[]): string {
  return HAND_NAMES_3[evaluate3(hand)[0]];
}

// Players still holding chips.
export function survivors(state: ThreeCardState): string[] {
  return state.playerIds.filter((id) => (state.stacks[id] ?? 0) > 0);
}
