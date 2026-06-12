export type Suit = "♠" | "♥" | "♦" | "♣";
export type CardRank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface BlackjackCard {
  rank: CardRank;
  suit: Suit;
  display: string;
}

export interface BlackjackPlayerHand {
  playerId: string;
  hand: BlackjackCard[];
  standing: boolean;
  busted: boolean;
}

export type BlackjackOutcome = "win" | "lose" | "push" | "blackjack";

export interface BlackjackState {
  phase: "playing" | "dealer" | "result";
  stake: number;
  hands: BlackjackPlayerHand[];
  dealerHand: BlackjackCard[];
  dealerRevealed: boolean;
  deck: BlackjackCard[];
  results: Record<string, BlackjackOutcome> | null;
}

// Dealer must hit until reaching 17 or more, then must stand.
export const DEALER_STANDS_ON = 17;

const SUITS: Suit[] = ["♠", "♥", "♦", "♣"];
const RANK_DISPLAY: Record<CardRank, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7",
  8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A",
};

function buildDeck(): BlackjackCard[] {
  const deck: BlackjackCard[] = [];
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

export function cardValue(card: BlackjackCard): number {
  if (card.rank >= 11 && card.rank <= 13) return 10; // J, Q, K
  if (card.rank === 14) return 11; // Ace (softened below)
  return card.rank;
}

export function handValue(hand: BlackjackCard[]): number {
  let total = hand.reduce((sum, c) => sum + cardValue(c), 0);
  let aces = hand.filter((c) => c.rank === 14).length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

export function isBlackjack(hand: BlackjackCard[]): boolean {
  return hand.length === 2 && handValue(hand) === 21;
}

export function isBusted(hand: BlackjackCard[]): boolean {
  return handValue(hand) > 21;
}

export function initBlackjackState(
  playerIds: string[],
  stake: number
): BlackjackState {
  const deck = buildDeck();

  const hands: BlackjackPlayerHand[] = playerIds.map((playerId) => {
    const hand = [deck.pop()!, deck.pop()!];
    return {
      playerId,
      hand,
      // A natural blackjack can't be improved — auto-stand.
      standing: isBlackjack(hand),
      busted: false,
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

export function hitPlayer(
  state: BlackjackState,
  playerId: string
): BlackjackState {
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

export function standPlayer(
  state: BlackjackState,
  playerId: string
): BlackjackState {
  const newHands = state.hands.map((ph) =>
    ph.playerId === playerId ? { ...ph, standing: true } : ph
  );
  return { ...state, hands: newHands };
}

export function allPlayersDone(state: BlackjackState): boolean {
  return state.hands.every((ph) => ph.standing || ph.busted);
}

// Stage 1: flip the hole card, before the dealer draws.
export function revealDealer(state: BlackjackState): BlackjackState {
  return { ...state, phase: "dealer", dealerRevealed: true };
}

// Stage 2: dealer draws to 17+, then every player is scored
// against the dealer — players never compete with each other.
export function resolveDealer(state: BlackjackState): BlackjackState {
  const deck = [...state.deck];
  const dealerHand = [...state.dealerHand];

  while (handValue(dealerHand) < DEALER_STANDS_ON) {
    dealerHand.push(deck.pop()!);
  }

  const dealerBJ = isBlackjack(state.dealerHand);
  const dealerValue = handValue(dealerHand);
  const dealerBusted = dealerValue > 21;

  const results: Record<string, BlackjackOutcome> = {};
  for (const ph of state.hands) {
    const playerBJ = isBlackjack(ph.hand);
    const value = handValue(ph.hand);

    if (ph.busted) results[ph.playerId] = "lose";
    else if (playerBJ && dealerBJ) results[ph.playerId] = "push";
    else if (playerBJ) results[ph.playerId] = "blackjack";
    else if (dealerBJ) results[ph.playerId] = "lose";
    else if (dealerBusted) results[ph.playerId] = "win";
    else if (value > dealerValue) results[ph.playerId] = "win";
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

// Chips returned to the player (their stake was collected at game start):
// win pays 1:1, blackjack pays 3:2, push returns the stake.
export function payoutFor(outcome: BlackjackOutcome, stake: number): number {
  switch (outcome) {
    case "blackjack": return Math.floor(stake * 2.5);
    case "win": return stake * 2;
    case "push": return stake;
    case "lose": return 0;
  }
}
