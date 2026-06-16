// Free Bet Blackjack: standard blackjack vs the dealer, plus
// — free double down on hard 9, 10, 11 (the house covers the double)
// — dealer 22 pushes all live hands instead of busting
// Free splits are not implemented.
//
// Multi-round bankroll table: each player has a running stack and chooses a
// wager each hand. A human dealerId (if set) banks the table; otherwise the
// automated house banks.

export type Suit = "♠" | "♥" | "♦" | "♣";
export type CardRank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface FBCard {
  rank: CardRank;
  suit: Suit;
  display: string;
}

// "win_double" = won a free-doubled hand → 3x the wager back (wager + 2x win)
export type FBOutcome = "win" | "lose" | "push" | "blackjack" | "win_double";

export interface FBPlayerHand {
  playerId: string;
  hand: FBCard[];
  standing: boolean;
  busted: boolean;
  doubled: boolean;
}

export interface FreeBetState {
  phase: "betting" | "playing" | "dealer" | "result";
  stake: number;                         // buy-in (reference)
  round: number;
  dealerId: string | null;
  playerIds: string[];
  stacks: Record<string, number>;
  bets: Record<string, number>;
  hands: FBPlayerHand[];
  dealerHand: FBCard[];
  dealerRevealed: boolean;
  deck: FBCard[];
  results: Record<string, FBOutcome> | null;
  ended: boolean;
  rebuyReq: string[];
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
  while (total > 21 && aces > 0) { total -= 10; aces--; }
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

// ----- table lifecycle -----

export function initFreeBetTable(playerIds: string[], buyIn: number, dealerId: string | null): FreeBetState {
  const stacks: Record<string, number> = {};
  for (const id of playerIds) stacks[id] = buyIn;
  if (dealerId) stacks[dealerId] = buyIn;
  return {
    phase: "betting", stake: buyIn, round: 1, dealerId, playerIds, stacks,
    bets: {}, hands: [], dealerHand: [], dealerRevealed: false, deck: [], results: null, ended: false, rebuyReq: [],
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
    return { playerId, hand, standing: isBlackjack(hand), busted: false, doubled: false };
  });
  const dealerHand = [deck.pop()!, deck.pop()!];
  return { ...state, phase: "playing", deck, hands, dealerHand, dealerRevealed: false, results: null };
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
  return { ...state, hands: state.hands.map((ph) => (ph.playerId === playerId ? { ...ph, standing: true } : ph)) };
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
  while (handValue(dealerHand) < DEALER_STANDS_ON) dealerHand.push(deck.pop()!);

  const dealerBJ = isBlackjack(state.dealerHand);
  const dealerValue = handValue(dealerHand);
  const dealer22 = dealerValue === 22; // pushes instead of busting
  const dealerBusted = dealerValue > 22;

  const results: Record<string, FBOutcome> = {};
  const stacks = { ...state.stacks };
  let dealerNet = 0;

  for (const ph of state.hands) {
    const playerBJ = isBlackjack(ph.hand);
    const value = handValue(ph.hand);
    let outcome: FBOutcome;
    if (ph.busted) outcome = "lose";
    else if (playerBJ && dealerBJ) outcome = "push";
    else if (playerBJ) outcome = "blackjack";
    else if (dealerBJ) outcome = "lose";
    else if (dealer22) outcome = "push";
    else if (dealerBusted || value > dealerValue) outcome = ph.doubled ? "win_double" : "win";
    else if (value < dealerValue) outcome = "lose";
    else outcome = "push";
    results[ph.playerId] = outcome;

    const bet = state.bets[ph.playerId] ?? 0;
    const pay = payoutFor(outcome, bet);
    stacks[ph.playerId] = (stacks[ph.playerId] ?? 0) + pay;
    dealerNet += bet - pay;
  }

  if (state.dealerId) stacks[state.dealerId] = (stacks[state.dealerId] ?? 0) + dealerNet;

  return { ...state, deck, dealerHand, dealerRevealed: true, phase: "result", results, stacks };
}

export function nextHand(state: FreeBetState): FreeBetState {
  return {
    ...state, phase: "betting", round: state.round + 1,
    bets: {}, hands: [], dealerHand: [], dealerRevealed: false, results: null,
  };
}

// Chips returned to the player (the wager was escrowed out of their stack).
export function payoutFor(outcome: FBOutcome, bet: number): number {
  switch (outcome) {
    case "win_double": return bet * 3;           // wager + 2x free-double win
    case "blackjack": return bet + Math.floor(bet * 1.5);
    case "win": return bet * 2;
    case "push": return bet;
    case "lose": return 0;
  }
}

export function tableBroke(state: FreeBetState): boolean {
  return state.playerIds.every((id) => (state.stacks[id] ?? 0) <= 0) && state.rebuyReq.length === 0;
}
