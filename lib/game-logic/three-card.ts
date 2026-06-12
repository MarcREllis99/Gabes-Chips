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

// Outcome keys map to finish_blackjack payout multipliers:
// "blackjack" = 2.5x return — used as the straight-or-better bonus.
export type ThreeCardOutcome = "win" | "lose" | "push" | "blackjack";

export interface ThreeCardPlayer {
  playerId: string;
  hand: PCard[];
  decision: "play" | "fold" | null;
}

export interface ThreeCardState {
  phase: "deciding" | "reveal" | "result";
  stake: number;
  players: ThreeCardPlayer[];
  dealerHand: PCard[];
  dealerRevealed: boolean;
  dealerQualified: boolean | null;
  deck: PCard[];
  results: Record<string, ThreeCardOutcome> | null;
}

export function initThreeCardState(playerIds: string[], stake: number): ThreeCardState {
  const deck = buildDeck();
  const players: ThreeCardPlayer[] = playerIds.map((playerId) => ({
    playerId,
    hand: [deck.pop()!, deck.pop()!, deck.pop()!],
    decision: null,
  }));
  const dealerHand = [deck.pop()!, deck.pop()!, deck.pop()!];

  return {
    phase: "deciding",
    stake,
    players,
    dealerHand,
    dealerRevealed: false,
    dealerQualified: null,
    deck,
    results: null,
  };
}

export function decide(
  state: ThreeCardState,
  playerId: string,
  decision: "play" | "fold"
): ThreeCardState {
  return {
    ...state,
    players: state.players.map((p) =>
      p.playerId === playerId && p.decision === null ? { ...p, decision } : p
    ),
  };
}

export function allDecided(state: ThreeCardState): boolean {
  return state.players.every((p) => p.decision !== null);
}

export function revealDealer3(state: ThreeCardState): ThreeCardState {
  return { ...state, phase: "reveal", dealerRevealed: true };
}

export function resolveThreeCard(state: ThreeCardState): ThreeCardState {
  const dealerScore = evaluate3(state.dealerHand);
  const qualified = dealerQualifies3(dealerScore);

  const results: Record<string, ThreeCardOutcome> = {};
  for (const p of state.players) {
    if (p.decision === "fold") {
      results[p.playerId] = "lose";
      continue;
    }
    const score = evaluate3(p.hand);
    const bonus = score[0] >= 3; // straight or better pays the bonus
    if (!qualified) {
      results[p.playerId] = bonus ? "blackjack" : "win";
      continue;
    }
    const cmp = compareScores(score, dealerScore);
    if (cmp > 0) results[p.playerId] = bonus ? "blackjack" : "win";
    else if (cmp < 0) results[p.playerId] = "lose";
    else results[p.playerId] = "push";
  }

  return {
    ...state,
    phase: "result",
    dealerRevealed: true,
    dealerQualified: qualified,
    results,
  };
}

export function threeCardPayout(outcome: ThreeCardOutcome, stake: number): number {
  switch (outcome) {
    case "blackjack": return Math.floor(stake * 2.5);
    case "win": return stake * 2;
    case "push": return stake;
    case "lose": return 0;
  }
}

export function handName3(hand: PCard[]): string {
  return HAND_NAMES_3[evaluate3(hand)[0]];
}
