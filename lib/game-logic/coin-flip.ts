export type CoinSide = "heads" | "tails";

export interface CoinFlipState {
  phase: "picking" | "flipping" | "result";
  stake: number;
  pot: number;
  hostId: string;
  guestId: string;
  hostSide: CoinSide | null;
  guestSide: CoinSide | null;
  result: CoinSide | null;
  winnerId: string | null;
}

export const HOUSE_RAKE = 0.05;

export function initCoinFlipState(
  hostId: string,
  guestId: string,
  stake: number
): CoinFlipState {
  return {
    phase: "picking",
    stake,
    pot: stake * 2,
    hostId,
    guestId,
    hostSide: null,
    guestSide: null,
    result: null,
    winnerId: null,
  };
}

export function flipCoin(): CoinSide {
  return Math.random() < 0.5 ? "heads" : "tails";
}

export function resolveCoinFlip(state: CoinFlipState): {
  result: CoinSide;
  winnerId: string;
  payout: number;
} {
  const result = flipCoin();
  const winnerId = result === state.hostSide ? state.hostId : state.guestId;
  const payout = Math.floor(state.pot * (1 - HOUSE_RAKE));
  return { result, winnerId, payout };
}
