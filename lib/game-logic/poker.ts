// Shared deck + poker hand evaluation for Texas Hold'em and 3 Card Poker.

export type Suit = "♠" | "♥" | "♦" | "♣";

export interface PCard {
  rank: number; // 2–14 (J=11, Q=12, K=13, A=14)
  suit: Suit;
  display: string;
}

const SUITS: Suit[] = ["♠", "♥", "♦", "♣"];
const DISPLAY: Record<number, string> = { 11: "J", 12: "Q", 13: "K", 14: "A" };

export function buildDeck(): PCard[] {
  const deck: PCard[] = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank++) {
      deck.push({ rank, suit, display: DISPLAY[rank] ?? String(rank) });
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

// Scores are arrays compared lexicographically: [category, tiebreak...]
export function compareScores(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ----- 5-card poker (Hold'em) -----

export const HAND_NAMES = [
  "High Card", "Pair", "Two Pair", "Three of a Kind", "Straight",
  "Flush", "Full House", "Four of a Kind", "Straight Flush",
];

export function evaluate5(cards: PCard[]): number[] {
  const byCount = new Map<number, number>();
  for (const c of cards) byCount.set(c.rank, (byCount.get(c.rank) ?? 0) + 1);
  // group ranks by count desc, then rank desc — gives pair/trip ordering + kickers
  const groups = [...byCount.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const kickers = groups.map(([rank]) => rank);
  const uniqDesc = [...byCount.keys()].sort((a, b) => b - a);
  const isFlush = cards.every((c) => c.suit === cards[0].suit);

  let straightHigh = 0;
  if (uniqDesc.length === 5) {
    if (uniqDesc[0] - uniqDesc[4] === 4) straightHigh = uniqDesc[0];
    else if (uniqDesc[0] === 14 && uniqDesc[1] === 5) straightHigh = 5; // wheel A-2-3-4-5
  }

  if (straightHigh && isFlush) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, ...kickers];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, ...kickers];
  if (isFlush) return [5, ...uniqDesc];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, ...kickers];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, ...kickers];
  if (groups[0][1] === 2) return [1, ...kickers];
  return [0, ...uniqDesc];
}

// Best 5-card hand from exactly 7 cards (2 hole + 5 board)
export function best7(cards: PCard[]): number[] {
  let best: number[] | null = null;
  for (let a = 0; a < cards.length; a++) {
    for (let b = a + 1; b < cards.length; b++) {
      const five = cards.filter((_, i) => i !== a && i !== b);
      const score = evaluate5(five);
      if (!best || compareScores(score, best) > 0) best = score;
    }
  }
  return best!;
}

// ----- 3 Card Poker -----
// Note: in 3-card poker a straight beats a flush.

export const HAND_NAMES_3 = [
  "High Card", "Pair", "Flush", "Straight", "Three of a Kind", "Straight Flush",
];

export function evaluate3(cards: PCard[]): number[] {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const uniq = [...new Set(ranks)];
  const isFlush = cards.every((c) => c.suit === cards[0].suit);

  let straightHigh = 0;
  if (uniq.length === 3) {
    if (uniq[0] - uniq[2] === 2) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 3 && uniq[2] === 2) straightHigh = 3; // A-2-3
  }

  if (straightHigh && isFlush) return [5, straightHigh];
  if (uniq.length === 1) return [4, ranks[0]];
  if (straightHigh) return [3, straightHigh];
  if (isFlush) return [2, ...ranks];
  if (uniq.length === 2) {
    const pairRank = ranks[0] === ranks[1] ? ranks[0] : ranks[1];
    const kicker = ranks.find((r) => r !== pairRank)!;
    return [1, pairRank, kicker];
  }
  return [0, ...ranks];
}

// Dealer needs Queen-high or better to qualify
export function dealerQualifies3(score: number[]): boolean {
  return score[0] >= 1 || score[1] >= 12;
}
