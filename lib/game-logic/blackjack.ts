export type Suit = "♠" | "♥" | "♦" | "♣";
export type CardRank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface BlackjackCard {
  rank: CardRank;
  suit: Suit;
  display: string;
}

export type BlackjackOutcome = "win" | "lose" | "push" | "blackjack";

// A single hand. A player normally has one, but a split creates more — each
// with its own wager, played in order.
export interface BlackjackPlayerHand {
  playerId: string;
  hand: BlackjackCard[];
  bet: number;             // chips wagered on THIS hand (escrowed)
  standing: boolean;
  busted: boolean;
  doubled: boolean;
  fromSplit: boolean;      // a split 21 is not a natural blackjack
  outcome: BlackjackOutcome | null;
}

// Multi-round bankroll table. Each player has a running stack; each hand they
// choose a bet and may double or split. A human dealerId (if set) banks the
// table with their own stack; otherwise the automated house banks.
export interface BlackjackState {
  phase: "betting" | "playing" | "dealer" | "result";
  stake: number;                         // buy-in (reference)
  round: number;
  dealerId: string | null;
  playerIds: string[];                   // seated (non-dealer) players, seat order
  stacks: Record<string, number>;
  bets: Record<string, number>;          // this hand's opening wager per seated player
  hands: BlackjackPlayerHand[];          // flat list; a player may own several
  dealerHand: BlackjackCard[];
  dealerRevealed: boolean;
  deck: BlackjackCard[];
  ended: boolean;
  rebuyReq: string[];
}

export const DEALER_STANDS_ON = 17;
export const MAX_HANDS_PER_PLAYER = 4;

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
  if (card.rank >= 11 && card.rank <= 13) return 10;
  if (card.rank === 14) return 11;
  return card.rank;
}

export function handValue(hand: BlackjackCard[]): number {
  let total = hand.reduce((sum, c) => sum + cardValue(c), 0);
  let aces = hand.filter((c) => c.rank === 14).length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

export function isBlackjack(hand: BlackjackCard[]): boolean {
  return hand.length === 2 && handValue(hand) === 21;
}
export function isBusted(hand: BlackjackCard[]): boolean {
  return handValue(hand) > 21;
}

// ----- table lifecycle -----

export function initBlackjackTable(playerIds: string[], buyIn: number, dealerId: string | null): BlackjackState {
  const stacks: Record<string, number> = {};
  for (const id of playerIds) stacks[id] = buyIn;
  if (dealerId) stacks[dealerId] = buyIn;
  return {
    phase: "betting", stake: buyIn, round: 1, dealerId, playerIds, stacks,
    bets: {}, hands: [], dealerHand: [], dealerRevealed: false, deck: [], ended: false, rebuyReq: [],
  };
}

export function setBet(state: BlackjackState, playerId: string, amount: number): BlackjackState {
  if (state.phase !== "betting" || playerId === state.dealerId) return state;
  const current = state.bets[playerId] ?? 0;
  const pool = (state.stacks[playerId] ?? 0) + current;
  const bet = Math.max(0, Math.min(Math.floor(amount), pool));
  return { ...state, stacks: { ...state.stacks, [playerId]: pool - bet }, bets: { ...state.bets, [playerId]: bet } };
}

export function anyBet(state: BlackjackState): boolean {
  return state.playerIds.some((id) => (state.bets[id] ?? 0) > 0);
}

export function dealHand(state: BlackjackState): BlackjackState {
  const bettors = state.playerIds.filter((id) => (state.bets[id] ?? 0) > 0);
  const deck = buildDeck();
  const hands: BlackjackPlayerHand[] = bettors.map((playerId) => {
    const hand = [deck.pop()!, deck.pop()!];
    return { playerId, hand, bet: state.bets[playerId] ?? 0, standing: isBlackjack(hand), busted: false, doubled: false, fromSplit: false, outcome: null };
  });
  const dealerHand = [deck.pop()!, deck.pop()!];
  return { ...state, phase: "playing", deck, hands, dealerHand, dealerRevealed: false };
}

// The hand a player is currently acting on (first one not yet finished).
export function activeHandIndex(state: BlackjackState, playerId: string): number {
  return state.hands.findIndex((h) => h.playerId === playerId && !h.standing && !h.busted);
}

export function hitPlayer(state: BlackjackState, playerId: string): BlackjackState {
  const i = activeHandIndex(state, playerId);
  if (i < 0) return state;
  const deck = [...state.deck];
  const card = deck.pop()!;
  const hands = state.hands.map((h, idx) => {
    if (idx !== i) return h;
    const hand = [...h.hand, card];
    const busted = isBusted(hand);
    return { ...h, hand, busted, standing: busted ? true : h.standing };
  });
  return { ...state, deck, hands };
}

export function standPlayer(state: BlackjackState, playerId: string): BlackjackState {
  const i = activeHandIndex(state, playerId);
  if (i < 0) return state;
  return { ...state, hands: state.hands.map((h, idx) => (idx === i ? { ...h, standing: true } : h)) };
}

export function canDouble(state: BlackjackState, playerId: string): boolean {
  const i = activeHandIndex(state, playerId);
  if (i < 0) return false;
  const h = state.hands[i];
  return h.hand.length === 2 && !h.doubled && (state.stacks[playerId] ?? 0) >= h.bet;
}

// Double the wager, take exactly one card, then stand.
export function doubleDown(state: BlackjackState, playerId: string): BlackjackState {
  const i = activeHandIndex(state, playerId);
  if (i < 0) return state;
  const h = state.hands[i];
  if (h.hand.length !== 2 || h.doubled || (state.stacks[playerId] ?? 0) < h.bet) return state;
  const deck = [...state.deck];
  const hand = [...h.hand, deck.pop()!];
  const busted = isBusted(hand);
  const stacks = { ...state.stacks, [playerId]: (state.stacks[playerId] ?? 0) - h.bet };
  const hands = state.hands.map((x, idx) => (idx === i ? { ...x, hand, bet: h.bet * 2, doubled: true, busted, standing: true } : x));
  return { ...state, deck, stacks, hands };
}

export function canSplit(state: BlackjackState, playerId: string): boolean {
  const i = activeHandIndex(state, playerId);
  if (i < 0) return false;
  const h = state.hands[i];
  if (h.hand.length !== 2 || h.hand[0].rank !== h.hand[1].rank) return false;
  if ((state.stacks[playerId] ?? 0) < h.bet) return false;
  return state.hands.filter((x) => x.playerId === playerId).length < MAX_HANDS_PER_PLAYER;
}

// Split a pair into two hands, each dealt a fresh card. Split aces get one
// card each and auto-stand.
export function splitHand(state: BlackjackState, playerId: string): BlackjackState {
  const i = activeHandIndex(state, playerId);
  if (i < 0) return state;
  const h = state.hands[i];
  if (h.hand.length !== 2 || h.hand[0].rank !== h.hand[1].rank || (state.stacks[playerId] ?? 0) < h.bet) return state;
  if (state.hands.filter((x) => x.playerId === playerId).length >= MAX_HANDS_PER_PLAYER) return state;

  const deck = [...state.deck];
  const isAces = h.hand[0].rank === 14;
  const make = (first: BlackjackCard): BlackjackPlayerHand => {
    const hand = [first, deck.pop()!];
    const busted = isBusted(hand);
    return { playerId, hand, bet: h.bet, standing: isAces || busted, busted, doubled: false, fromSplit: true, outcome: null };
  };
  const handA = make(h.hand[0]);
  const handB = make(h.hand[1]);
  const stacks = { ...state.stacks, [playerId]: (state.stacks[playerId] ?? 0) - h.bet };
  const hands = [...state.hands];
  hands.splice(i, 1, handA, handB);
  return { ...state, deck, stacks, hands };
}

export function allPlayersDone(state: BlackjackState): boolean {
  return state.hands.every((h) => h.standing || h.busted);
}

export function revealDealer(state: BlackjackState): BlackjackState {
  return { ...state, phase: "dealer", dealerRevealed: true };
}

// Dealer draws to 17+, every hand is scored, stacks settle.
export function resolveDealer(state: BlackjackState): BlackjackState {
  const deck = [...state.deck];
  const dealerHand = [...state.dealerHand];
  while (handValue(dealerHand) < DEALER_STANDS_ON) dealerHand.push(deck.pop()!);

  const dealerBJ = isBlackjack(state.dealerHand);
  const dealerValue = handValue(dealerHand);
  const dealerBusted = dealerValue > 21;

  const stacks = { ...state.stacks };
  let dealerNet = 0;

  const hands = state.hands.map((ph) => {
    const playerBJ = !ph.fromSplit && isBlackjack(ph.hand);
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

    const pay = payoutFor(outcome, ph.bet);
    stacks[ph.playerId] = (stacks[ph.playerId] ?? 0) + pay;
    dealerNet += ph.bet - pay;
    return { ...ph, outcome };
  });

  if (state.dealerId) stacks[state.dealerId] = (stacks[state.dealerId] ?? 0) + dealerNet;

  return { ...state, deck, dealerHand, dealerRevealed: true, phase: "result", hands, stacks };
}

export function nextHand(state: BlackjackState): BlackjackState {
  return { ...state, phase: "betting", round: state.round + 1, bets: {}, hands: [], dealerHand: [], dealerRevealed: false };
}

// Chips returned to the player (the wager was escrowed out of their stack).
export function payoutFor(outcome: BlackjackOutcome, bet: number): number {
  switch (outcome) {
    case "blackjack": return bet + Math.floor(bet * 1.5);
    case "win": return bet * 2;
    case "push": return bet;
    case "lose": return 0;
  }
}

export function tableBroke(state: BlackjackState): boolean {
  return state.playerIds.every((id) => (state.stacks[id] ?? 0) <= 0) && state.rebuyReq.length === 0;
}
