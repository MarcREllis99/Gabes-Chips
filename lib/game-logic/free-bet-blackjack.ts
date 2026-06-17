// Free Bet Blackjack — standard blackjack vs the dealer, with the defining
// features:
//   • FREE DOUBLE on hard 9, 10, 11 — the house matches your wager; you win as
//     if doubled but only risk your original bet.
//   • FREE SPLIT on any pair except 10-value cards — the house funds the extra
//     hand(s). 10-value pairs may still be split, but you pay for it.
//   • Dealer 22 pushes all live hands instead of busting.
//   • Blackjack pays 3:2.
//
// Each hand tracks `bet` (your escrowed chips, at risk) and `freeBet`
// (house-funded — pays you on a win, costs nothing on a loss).
//
// Multi-round bankroll table: each player has a running stack and chooses a
// wager each hand. A human dealerId (if set) banks the table (funding the free
// bets, offset by 22-pushes); otherwise the automated house banks.

export type Suit = "♠" | "♥" | "♦" | "♣";
export type CardRank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface FBCard {
  rank: CardRank;
  suit: Suit;
  display: string;
}

export type FBOutcome = "win" | "lose" | "push" | "blackjack";

export interface FBPlayerHand {
  playerId: string;
  hand: FBCard[];
  bet: number;        // your chips on this hand (at risk)
  freeBet: number;    // house-funded portion (pays on win, free on loss)
  standing: boolean;
  busted: boolean;
  doubled: boolean;
  fromSplit: boolean; // a split 21 is not a natural blackjack
  outcome: FBOutcome | null;
}

export interface FreeBetState {
  phase: "betting" | "playing" | "dealer" | "result";
  stake: number;                         // buy-in (reference)
  round: number;
  dealerId: string | null;
  playerIds: string[];
  stacks: Record<string, number>;
  bets: Record<string, number>;          // opening wager per seated player
  hands: FBPlayerHand[];
  dealerHand: FBCard[];
  dealerRevealed: boolean;
  deck: FBCard[];
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
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

export function isBlackjack(hand: FBCard[]): boolean {
  return hand.length === 2 && handValue(hand) === 21;
}
export function isBusted(hand: FBCard[]): boolean {
  return handValue(hand) > 21;
}

// ----- table lifecycle -----

export function initFreeBetTable(playerIds: string[], buyIn: number, dealerId: string | null): FreeBetState {
  const stacks: Record<string, number> = {};
  for (const id of playerIds) stacks[id] = buyIn;
  if (dealerId) stacks[dealerId] = buyIn;
  return {
    phase: "betting", stake: buyIn, round: 1, dealerId, playerIds, stacks,
    bets: {}, hands: [], dealerHand: [], dealerRevealed: false, deck: [], ended: false, rebuyReq: [],
  };
}

export function setBet(state: FreeBetState, playerId: string, amount: number): FreeBetState {
  if (state.phase !== "betting" || playerId === state.dealerId) return state;
  const current = state.bets[playerId] ?? 0;
  const pool = (state.stacks[playerId] ?? 0) + current;
  const bet = Math.max(0, Math.min(Math.floor(amount), pool));
  return { ...state, stacks: { ...state.stacks, [playerId]: pool - bet }, bets: { ...state.bets, [playerId]: bet } };
}

export function anyBet(state: FreeBetState): boolean {
  return state.playerIds.some((id) => (state.bets[id] ?? 0) > 0);
}

export function dealHand(state: FreeBetState): FreeBetState {
  const bettors = state.playerIds.filter((id) => (state.bets[id] ?? 0) > 0);
  const deck = buildDeck();
  const hands: FBPlayerHand[] = bettors.map((playerId) => {
    const hand = [deck.pop()!, deck.pop()!];
    return { playerId, hand, bet: state.bets[playerId] ?? 0, freeBet: 0, standing: isBlackjack(hand), busted: false, doubled: false, fromSplit: false, outcome: null };
  });
  const dealerHand = [deck.pop()!, deck.pop()!];
  return { ...state, phase: "playing", deck, hands, dealerHand, dealerRevealed: false };
}

export function activeHandIndex(state: FreeBetState, playerId: string): number {
  return state.hands.findIndex((h) => h.playerId === playerId && !h.standing && !h.busted);
}

export function hitPlayer(state: FreeBetState, playerId: string): FreeBetState {
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

export function standPlayer(state: FreeBetState, playerId: string): FreeBetState {
  const i = activeHandIndex(state, playerId);
  if (i < 0) return state;
  return { ...state, hands: state.hands.map((h, idx) => (idx === i ? { ...h, standing: true } : h)) };
}

// Free double: only on a hard 9, 10 or 11 (two cards, no ace). The house
// matches your wager — no chips of yours are risked.
export function canFreeDouble(state: FreeBetState, playerId: string): boolean {
  const i = activeHandIndex(state, playerId);
  if (i < 0) return false;
  const h = state.hands[i];
  if (h.hand.length !== 2 || h.doubled) return false;
  if (h.hand.some((c) => c.rank === 14)) return false; // hard only
  const v = handValue(h.hand);
  return v === 9 || v === 10 || v === 11;
}

export function freeDouble(state: FreeBetState, playerId: string): FreeBetState {
  const i = activeHandIndex(state, playerId);
  if (i < 0) return state;
  const h = state.hands[i];
  if (!canFreeDouble(state, playerId)) return state;
  const deck = [...state.deck];
  const hand = [...h.hand, deck.pop()!];
  const busted = isBusted(hand);
  const wager = h.bet + h.freeBet;
  const hands = state.hands.map((x, idx) => (idx === i ? { ...x, hand, freeBet: x.freeBet + wager, doubled: true, busted, standing: true } : x));
  return { ...state, deck, hands };
}

function isTenValue(card: FBCard): boolean {
  return cardValue(card) === 10;
}

export function canSplit(state: FreeBetState, playerId: string): boolean {
  const i = activeHandIndex(state, playerId);
  if (i < 0) return false;
  const h = state.hands[i];
  if (h.hand.length !== 2 || h.hand[0].rank !== h.hand[1].rank) return false;
  if (state.hands.filter((x) => x.playerId === playerId).length >= MAX_HANDS_PER_PLAYER) return false;
  // 10-value pairs cost you (a paid split); everything else is free
  if (isTenValue(h.hand[0])) return (state.stacks[playerId] ?? 0) >= h.bet + h.freeBet;
  return true;
}

// Whether splitting the active hand would be a FREE split (house-funded).
export function splitIsFree(state: FreeBetState, playerId: string): boolean {
  const i = activeHandIndex(state, playerId);
  if (i < 0) return false;
  return !isTenValue(state.hands[i].hand[0]);
}

export function splitHand(state: FreeBetState, playerId: string): FreeBetState {
  const i = activeHandIndex(state, playerId);
  if (i < 0) return state;
  const h = state.hands[i];
  if (h.hand.length !== 2 || h.hand[0].rank !== h.hand[1].rank) return state;
  if (state.hands.filter((x) => x.playerId === playerId).length >= MAX_HANDS_PER_PLAYER) return state;

  const wager = h.bet + h.freeBet;     // this hand's stake
  const ten = isTenValue(h.hand[0]);
  if (ten && (state.stacks[playerId] ?? 0) < wager) return state;

  const deck = [...state.deck];
  const isAces = h.hand[0].rank === 14;
  // hand A keeps the original stake; hand B is free (or paid, for tens)
  const handA: FBPlayerHand = (() => {
    const hand = [h.hand[0], deck.pop()!];
    const busted = isBusted(hand);
    return { playerId, hand, bet: h.bet, freeBet: h.freeBet, standing: isAces || busted, busted, doubled: false, fromSplit: true, outcome: null };
  })();
  const handB: FBPlayerHand = (() => {
    const hand = [h.hand[1], deck.pop()!];
    const busted = isBusted(hand);
    return {
      playerId, hand,
      bet: ten ? wager : 0,
      freeBet: ten ? 0 : wager,
      standing: isAces || busted, busted, doubled: false, fromSplit: true, outcome: null,
    };
  })();

  const stacks = ten ? { ...state.stacks, [playerId]: (state.stacks[playerId] ?? 0) - wager } : state.stacks;
  const hands = [...state.hands];
  hands.splice(i, 1, handA, handB);
  return { ...state, deck, stacks, hands };
}

export function allPlayersDone(state: FreeBetState): boolean {
  return state.hands.every((h) => h.standing || h.busted);
}

export function revealDealer(state: FreeBetState): FreeBetState {
  return { ...state, phase: "dealer", dealerRevealed: true };
}

export function resolveDealer(state: FreeBetState): FreeBetState {
  const deck = [...state.deck];
  const dealerHand = [...state.dealerHand];
  while (handValue(dealerHand) < DEALER_STANDS_ON) dealerHand.push(deck.pop()!);

  const dealerBJ = isBlackjack(state.dealerHand);
  const dealerValue = handValue(dealerHand);
  const dealer22 = dealerValue === 22;   // pushes instead of busting
  const dealerBusted = dealerValue > 22;

  const stacks = { ...state.stacks };
  let dealerNet = 0;

  const hands = state.hands.map((ph) => {
    const playerBJ = !ph.fromSplit && isBlackjack(ph.hand);
    const value = handValue(ph.hand);
    let outcome: FBOutcome;
    if (ph.busted) outcome = "lose";
    else if (playerBJ && dealerBJ) outcome = "push";
    else if (playerBJ) outcome = "blackjack";
    else if (dealerBJ) outcome = "lose";
    else if (dealer22) outcome = "push";
    else if (dealerBusted || value > dealerValue) outcome = "win";
    else if (value < dealerValue) outcome = "lose";
    else outcome = "push";

    const pay = payoutFor(outcome, ph.bet, ph.freeBet);
    stacks[ph.playerId] = (stacks[ph.playerId] ?? 0) + pay;
    dealerNet += ph.bet - pay;
    return { ...ph, outcome };
  });

  if (state.dealerId) stacks[state.dealerId] = (stacks[state.dealerId] ?? 0) + dealerNet;

  return { ...state, deck, dealerHand, dealerRevealed: true, phase: "result", hands, stacks };
}

export function nextHand(state: FreeBetState): FreeBetState {
  return { ...state, phase: "betting", round: state.round + 1, bets: {}, hands: [], dealerHand: [], dealerRevealed: false };
}

// Chips returned to the player. The wager (`bet`) was escrowed out of their
// stack; `freeBet` is house-funded (pays on a win, costs nothing otherwise).
export function payoutFor(outcome: FBOutcome, bet: number, freeBet: number): number {
  switch (outcome) {
    case "blackjack": return bet + Math.floor(bet * 1.5);
    case "win": return bet * 2 + freeBet;
    case "push": return bet;
    case "lose": return 0;
  }
}

export function tableBroke(state: FreeBetState): boolean {
  return state.playerIds.every((id) => (state.stacks[id] ?? 0) <= 0) && state.rebuyReq.length === 0;
}
