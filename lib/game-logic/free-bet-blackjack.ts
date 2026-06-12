// Free Bet Blackjack: standard blackjack vs the dealer, plus
// — free double down on hard 9, 10, 11 (the house covers the double)
// — dealer 22 pushes all live hands instead of busting
// Free splits are not implemented.

export type Suit = "♠" | "♥" | "♦" | "♣";
export type CardRank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface FBCard {
  rank: CardRank;
  suit: Suit;
  display: string;
}

// "win_double" = won a free-doubled hand → 3x stake back (stake + 2x winnings)
export type FBOutcome = "win" | "lose" | "push" | "blackjack" | "win_double";

export interface FBPlayerHand {
  playerId: string;
  hand: FBCard[];
  standing: boolean;
  busted: boolean;
  doubled: boolean;
}

export interface FreeBetState {
  phase: "playing" | "dealer" | "result";
  stake: number;
  hands: FBPlayerHand[];
  dealerHand: FBCard[];
  dealerRevealed: boolean;
  deck: FBCard[];
  results: Record<string, FBOutcome> | null;
}

export const DEALER_STANDS_ON = 17;

const SUITS: Suit[] = ["♠", "♥", "♦", "♣"];
const RANK_DISPLAY: Record<CardRank, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7",
  8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A",
};

function buildDeck(): FBCard[] {
  const deck: FBCard[] = [];
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

export function cardValue(card: FBCard): number {
  if (card.rank >= 11 && card.rank <= 13) return 10;
  if (card.rank === 14) return 11;
  return card.rank;
}

export function handValue(hand: FBCard[]): number {
  let total = hand.reduce((sum, c) => sum + cardValue(c), 0);
  let aces = hand.filter((c) => c.rank === 14).length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

export function isBlackjack(hand: FBCard[]): boolean {
  return hand.length === 2 && handValue(hand) === 21;
}

export function isBusted(hand: FBCard[]): boolean {
  return handValue(hand) > 21;
}

// Free double: first two cards, no ace, totalling hard 9, 10, or 11
export function canFreeDouble(ph: FBPlayerHand): boolean {
  if (ph.standing || ph.busted || ph.hand.length !== 2) return false;
  if (ph.hand.some((c) => c.rank === 14)) return false;
  const v = handValue(ph.hand);
  return v === 9 || v === 10 || v === 11;
}

export function initFreeBetState(playerIds: string[], stake: number): FreeBetState {
  const deck = buildDeck();
  const hands: FBPlayerHand[] = playerIds.map((playerId) => {
    const hand = [deck.pop()!, deck.pop()!];
    return {
      playerId,
      hand,
      standing: isBlackjack(hand),
      busted: false,
      doubled: false,
    };
  });
  const dealerHand = [deck.pop()!, deck.pop()!];

  return {
    phase: "playing",
    stake,
    hands,
    dealerHand,
    dealerRevealed: false,
    deck,
    results: null,
  };
}

export function hitPlayer(state: FreeBetState, playerId: string): FreeBetState {
  const newDeck = [...state.deck];
  const newCard = newDeck.pop()!;

  const newHands = state.hands.map((ph) => {
    if (ph.playerId !== playerId || ph.standing || ph.busted) return ph;
    const hand = [...ph.hand, newCard];
    const busted = isBusted(hand);
    return { ...ph, hand, busted, standing: busted ? true : ph.standing };
  });

  return { ...state, deck: newDeck, hands: newHands };
}

export function standPlayer(state: FreeBetState, playerId: string): FreeBetState {
  const newHands = state.hands.map((ph) =>
    ph.playerId === playerId ? { ...ph, standing: true } : ph
  );
  return { ...state, hands: newHands };
}

// One card, then auto-stand — the doubled flag upgrades a win to 3x.
export function freeDoublePlayer(state: FreeBetState, playerId: string): FreeBetState {
  const newDeck = [...state.deck];
  const newCard = newDeck.pop()!;

  const newHands = state.hands.map((ph) => {
    if (ph.playerId !== playerId || !canFreeDouble(ph)) return ph;
    const hand = [...ph.hand, newCard];
    const busted = isBusted(hand);
    return { ...ph, hand, busted, standing: true, doubled: true };
  });

  return { ...state, deck: newDeck, hands: newHands };
}

export function allPlayersDone(state: FreeBetState): boolean {
  return state.hands.every((ph) => ph.standing || ph.busted);
}

export function revealDealer(state: FreeBetState): FreeBetState {
  return { ...state, phase: "dealer", dealerRevealed: true };
}

export function resolveDealer(state: FreeBetState): FreeBetState {
  const deck = [...state.deck];
  const dealerHand = [...state.dealerHand];

  while (handValue(dealerHand) < DEALER_STANDS_ON) {
    dealerHand.push(deck.pop()!);
  }

  const dealerBJ = isBlackjack(state.dealerHand);
  const dealerValue = handValue(dealerHand);
  const dealer22 = dealerValue === 22; // pushes instead of busting
  const dealerBusted = dealerValue > 22;

  const results: Record<string, FBOutcome> = {};
  for (const ph of state.hands) {
    const playerBJ = isBlackjack(ph.hand);
    const value = handValue(ph.hand);

    if (ph.busted) results[ph.playerId] = "lose";
    else if (playerBJ && dealerBJ) results[ph.playerId] = "push";
    else if (playerBJ) results[ph.playerId] = "blackjack"; // naturals beat dealer 22 too
    else if (dealerBJ) results[ph.playerId] = "lose";
    else if (dealer22) results[ph.playerId] = "push";
    else if (dealerBusted || value > dealerValue) results[ph.playerId] = ph.doubled ? "win_double" : "win";
    else if (value < dealerValue) results[ph.playerId] = "lose";
    else results[ph.playerId] = "push";
  }

  return {
    ...state,
    deck,
    dealerHand,
    dealerRevealed: true,
    phase: "result",
    results,
  };
}

export function payoutFor(outcome: FBOutcome, stake: number): number {
  switch (outcome) {
    case "win_double": return stake * 3;
    case "blackjack": return Math.floor(stake * 2.5);
    case "win": return stake * 2;
    case "push": return stake;
    case "lose": return 0;
  }
}
