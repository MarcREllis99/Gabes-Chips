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

// A multi-round bankroll table. Each player has a running `stack`; each hand
// they choose a `bet` from it. A human `dealerId` (if set) banks the table
// with their own stack; otherwise the automated house banks (infinite funds).
export interface BlackjackState {
  phase: "betting" | "playing" | "dealer" | "result";
  stake: number;                         // buy-in (reference)
  round: number;
  dealerId: string | null;               // human bank, or null = automated house
  playerIds: string[];                   // seated (non-dealer) players, seat order
  stacks: Record<string, number>;        // current table stacks (incl. human dealer)
  bets: Record<string, number>;          // this hand's wager per seated player
  hands: BlackjackPlayerHand[];          // only players who wagered this hand
  dealerHand: BlackjackCard[];
  dealerRevealed: boolean;
  deck: BlackjackCard[];
  results: Record<string, BlackjackOutcome> | null;
  ended: boolean;                        // table closed by the dealer/host
  rebuyReq: string[];                    // players asking to rebuy
}

// Dealer must hit until reaching 17 or more, then must stand.
export const DEALER_STANDS_ON = 17;

const SUITS: Suit[] = ["♠", "♥", "♦", "♣"];
const RANK_DISPLAY: Record<CardRank, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7",
  8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A",
};

export function buildDeck(): BlackjackCard[] {
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

// ----- table lifecycle -----

export function initBlackjackTable(
  playerIds: string[],
  buyIn: number,
  dealerId: string | null
): BlackjackState {
  const stacks: Record<string, number> = {};
  for (const id of playerIds) stacks[id] = buyIn;
  if (dealerId) stacks[dealerId] = buyIn;
  return {
    phase: "betting",
    stake: buyIn,
    round: 1,
    dealerId,
    playerIds,
    stacks,
    bets: {},
    hands: [],
    dealerHand: [],
    dealerRevealed: false,
    deck: [],
    results: null,
    ended: false,
    rebuyReq: [],
  };
}

// Set a seated player's wager for the upcoming hand (escrowed out of the stack).
export function setBet(state: BlackjackState, playerId: string, amount: number): BlackjackState {
  if (state.phase !== "betting" || playerId === state.dealerId) return state;
  const current = state.bets[playerId] ?? 0;
  const pool = (state.stacks[playerId] ?? 0) + current; // refund the old escrow first
  const bet = Math.max(0, Math.min(Math.floor(amount), pool));
  return {
    ...state,
    stacks: { ...state.stacks, [playerId]: pool - bet },
    bets: { ...state.bets, [playerId]: bet },
  };
}

export function anyBet(state: BlackjackState): boolean {
  return state.playerIds.some((id) => (state.bets[id] ?? 0) > 0);
}

// Deal the hand to everyone who wagered. Sitting-out players are skipped.
export function dealHand(state: BlackjackState): BlackjackState {
  const bettors = state.playerIds.filter((id) => (state.bets[id] ?? 0) > 0);
  const deck = buildDeck();
  const hands: BlackjackPlayerHand[] = bettors.map((playerId) => {
    const hand = [deck.pop()!, deck.pop()!];
    return { playerId, hand, standing: isBlackjack(hand), busted: false };
  });
  const dealerHand = [deck.pop()!, deck.pop()!];
  return {
    ...state,
    phase: "playing",
    deck,
    hands,
    dealerHand,
    dealerRevealed: false,
    results: null,
  };
}

export function hitPlayer(state: BlackjackState, playerId: string): BlackjackState {
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

export function standPlayer(state: BlackjackState, playerId: string): BlackjackState {
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

// Stage 2: dealer draws to 17+, everyone is scored, stacks settle.
export function resolveDealer(state: BlackjackState): BlackjackState {
  const deck = [...state.deck];
  const dealerHand = [...state.dealerHand];
  while (handValue(dealerHand) < DEALER_STANDS_ON) dealerHand.push(deck.pop()!);

  const dealerBJ = isBlackjack(state.dealerHand);
  const dealerValue = handValue(dealerHand);
  const dealerBusted = dealerValue > 21;

  const results: Record<string, BlackjackOutcome> = {};
  const stacks = { ...state.stacks };
  let dealerNet = 0;

  for (const ph of state.hands) {
    const playerBJ = isBlackjack(ph.hand);
    const value = handValue(ph.hand);
    let outcome: BlackjackOutcome;
    if (ph.busted) outcome = "lose";
    else if (playerBJ && dealerBJ) outcome = "push";
    else if (playerBJ) outcome = "blackjack";
    else if (dealerBJ) outcome = "lose";
    else if (dealerBusted) outcome = "win";
    else if (value > dealerValue) outcome = "win";
    else if (value < dealerValue) outcome = "lose";
    else outcome = "push";
    results[ph.playerId] = outcome;

    const bet = state.bets[ph.playerId] ?? 0;
    const pay = payoutFor(outcome, bet);
    stacks[ph.playerId] = (stacks[ph.playerId] ?? 0) + pay;
    dealerNet += bet - pay; // dealer collects losses, covers wins
  }

  if (state.dealerId) stacks[state.dealerId] = (stacks[state.dealerId] ?? 0) + dealerNet;

  return { ...state, deck, dealerHand, dealerRevealed: true, phase: "result", results, stacks };
}

// Clear the table for the next hand (bets/cards reset; stacks carry over).
export function nextHand(state: BlackjackState): BlackjackState {
  return {
    ...state,
    phase: "betting",
    round: state.round + 1,
    bets: {},
    hands: [],
    dealerHand: [],
    dealerRevealed: false,
    results: null,
  };
}

// Chips returned to the player (the wager was escrowed out of their stack):
// win pays 1:1, blackjack pays 3:2, push returns the wager.
export function payoutFor(outcome: BlackjackOutcome, bet: number): number {
  switch (outcome) {
    case "blackjack": return bet + Math.floor(bet * 1.5);
    case "win": return bet * 2;
    case "push": return bet;
    case "lose": return 0;
  }
}

// Every seated player is out of chips and nobody is waiting on a rebuy.
export function tableBroke(state: BlackjackState): boolean {
  return state.playerIds.every((id) => (state.stacks[id] ?? 0) <= 0) && state.rebuyReq.length === 0;
}
