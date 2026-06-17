// Full Euchre — 4 players, 2 fixed partnerships (seats 0&2 vs 1&3),
// 24-card deck (9–A), bowers, two bidding rounds, going alone,
// follow-suit enforcement, march/euchre scoring, play to 10.

export type Suit = "♠" | "♥" | "♦" | "♣";
export interface ECard {
  rank: number; // 9,10,11(J),12(Q),13(K),14(A)
  suit: Suit;
  display: string;
}

export type EuchrePhase =
  | "bidding1"   // order up the turned card, or pass
  | "bidding2"   // name a different suit, or pass (dealer is stuck)
  | "discard"    // dealer discards after picking up the up card
  | "playing"    // trick play
  | "handover"   // hand scored, brief pause before next deal
  | "gameover";  // someone reached 10

export interface TrickPlay {
  player: number; // seat index
  card: ECard;
}

export interface EuchreState {
  phase: EuchrePhase;
  stake: number;
  pot: number;
  playerIds: string[];      // length 4, seating order; teams are [0,2] and [1,3]
  dealer: number;           // seat index of the dealer
  turn: number;             // whose action it is
  hands: Record<string, ECard[]>;
  upCard: ECard | null;     // turned-up card during bidding
  turnedDownSuit: Suit | null; // forbidden suit in round 2
  trump: Suit | null;
  makerTeam: 0 | 1 | null;  // team that named trump
  caller: number | null;    // seat that named trump
  alone: boolean;
  alonePlayer: number | null; // the lone maker; their partner sits out
  leader: number;            // who leads the current trick
  trick: TrickPlay[];
  tricks: [number, number];  // tricks won this hand, per team
  scores: [number, number];  // game score, per team (to 10)
  handNumber: number;
  handResult: string | null;
  winningTeam: 0 | 1 | null;
}

const SUITS: Suit[] = ["♠", "♥", "♦", "♣"];
const RANK_DISPLAY: Record<number, string> = { 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A" };

export const POINTS_TO_WIN = 10;
export const HOUSE_RAKE = 0; // no house rake — winners take the full pot

export function team(seat: number): 0 | 1 {
  return (seat % 2) as 0 | 1;
}
export function partner(seat: number): number {
  return (seat + 2) % 4;
}
export function sameColor(suit: Suit): Suit {
  switch (suit) {
    case "♠": return "♣";
    case "♣": return "♠";
    case "♥": return "♦";
    case "♦": return "♥";
  }
}

function buildDeck(): ECard[] {
  const deck: ECard[] = [];
  for (const suit of SUITS) {
    for (const rank of [9, 10, 11, 12, 13, 14]) {
      deck.push({ rank, suit, display: RANK_DISPLAY[rank] });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ----- Bower / trump logic -----
export function isRightBower(c: ECard, trump: Suit): boolean {
  return c.rank === 11 && c.suit === trump;
}
export function isLeftBower(c: ECard, trump: Suit): boolean {
  return c.rank === 11 && c.suit === sameColor(trump);
}
// The suit a card "counts as" — the left bower counts as trump.
export function effectiveSuit(c: ECard, trump: Suit | null): Suit {
  if (trump && isLeftBower(c, trump)) return trump;
  return c.suit;
}
export function isTrump(c: ECard, trump: Suit | null): boolean {
  return !!trump && effectiveSuit(c, trump) === trump;
}
// Higher wins. Only trump and led-suit cards can win a trick.
export function trickValue(c: ECard, trump: Suit, ledSuit: Suit): number {
  if (isRightBower(c, trump)) return 1000;
  if (isLeftBower(c, trump)) return 900;
  if (isTrump(c, trump)) return 100 + c.rank;
  if (effectiveSuit(c, trump) === ledSuit) return c.rank;
  return -1;
}

// ----- Setup -----
export function initEuchre(playerIds: string[], stake: number, dealer = 0): EuchreState {
  const deck = buildDeck();
  const hands: Record<string, ECard[]> = {};
  for (let i = 0; i < 4; i++) {
    hands[playerIds[i]] = deck.slice(i * 5, i * 5 + 5);
  }
  const upCard = deck[20];

  return {
    phase: "bidding1",
    stake,
    pot: stake * 4,
    playerIds,
    dealer,
    turn: (dealer + 1) % 4,
    hands,
    upCard,
    turnedDownSuit: null,
    trump: null,
    makerTeam: null,
    caller: null,
    alone: false,
    alonePlayer: null,
    leader: (dealer + 1) % 4,
    trick: [],
    tricks: [0, 0],
    scores: [0, 0],
    handNumber: 1,
    handResult: null,
    winningTeam: null,
  };
}

function sittingOut(state: EuchreState, seat: number): boolean {
  return state.alone && state.alonePlayer !== null && seat === partner(state.alonePlayer);
}
function firstActiveFrom(state: EuchreState, seat: number): number {
  let s = seat % 4;
  for (let i = 0; i < 4; i++) {
    if (!sittingOut(state, s)) return s;
    s = (s + 1) % 4;
  }
  return seat;
}
function nextActive(state: EuchreState, seat: number): number {
  let s = (seat + 1) % 4;
  for (let i = 0; i < 4; i++) {
    if (!sittingOut(state, s)) return s;
    s = (s + 1) % 4;
  }
  return seat;
}
function activeCount(state: EuchreState): number {
  return state.alone ? 3 : 4;
}
// A completed trick stays on screen until the winner leads the next one.
export function isTrickComplete(state: EuchreState): boolean {
  return state.trick.length >= activeCount(state);
}
export function trickWinnerSeat(state: EuchreState): number | null {
  if (!isTrickComplete(state) || !state.trump) return null;
  const ledSuit = effectiveSuit(state.trick[0].card, state.trump);
  let best = state.trick[0];
  for (const tp of state.trick) {
    if (trickValue(tp.card, state.trump, ledSuit) > trickValue(best.card, state.trump, ledSuit)) best = tp;
  }
  return best.player;
}

// ----- Legal plays -----
export function legalPlayIndices(state: EuchreState, seat: number): number[] {
  const hand = state.hands[state.playerIds[seat]];
  // Leading (no trick, or the previous completed trick is still shown)
  if (state.trick.length === 0 || isTrickComplete(state)) return hand.map((_, i) => i);
  const ledSuit = effectiveSuit(state.trick[0].card, state.trump);
  const followers = hand
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => effectiveSuit(c, state.trump) === ledSuit)
    .map(({ i }) => i);
  return followers.length > 0 ? followers : hand.map((_, i) => i);
}

// ----- Bidding actions -----
function beginPlay(state: EuchreState): EuchreState {
  const leader = firstActiveFrom(state, (state.dealer + 1) % 4);
  return { ...state, phase: "playing", leader, turn: leader, trick: [] };
}

export function orderUp(state: EuchreState, alone: boolean): EuchreState {
  if (state.phase !== "bidding1" || !state.upCard) return state;
  const caller = state.turn;
  const trump = state.upCard.suit;
  let next: EuchreState = {
    ...state,
    trump,
    makerTeam: team(caller),
    caller,
    alone,
    alonePlayer: alone ? caller : null,
  };

  // Dealer picks up the up card and must discard — unless the dealer is
  // sitting out (their partner went alone), in which case skip it.
  if (sittingOut(next, next.dealer)) {
    return beginPlay({ ...next, upCard: null });
  }
  const dealerId = next.playerIds[next.dealer];
  next = {
    ...next,
    hands: { ...next.hands, [dealerId]: [...next.hands[dealerId], next.upCard!] },
    upCard: null,
    phase: "discard",
    turn: next.dealer,
  };
  return next;
}

export function passBid(state: EuchreState): EuchreState {
  if (state.phase === "bidding1") {
    // After the dealer (last seat) passes, turn the card down → round 2
    if (state.turn === state.dealer) {
      return {
        ...state,
        phase: "bidding2",
        turnedDownSuit: state.upCard ? state.upCard.suit : null,
        turn: (state.dealer + 1) % 4,
      };
    }
    return { ...state, turn: (state.turn + 1) % 4 };
  }
  if (state.phase === "bidding2") {
    // Stick the dealer: the dealer cannot pass in round 2
    if (state.turn === state.dealer) return state;
    return { ...state, turn: (state.turn + 1) % 4 };
  }
  return state;
}

export function callTrump(state: EuchreState, suit: Suit, alone: boolean): EuchreState {
  if (state.phase !== "bidding2") return state;
  if (suit === state.turnedDownSuit) return state;
  const caller = state.turn;
  const next: EuchreState = {
    ...state,
    trump: suit,
    makerTeam: team(caller),
    caller,
    alone,
    alonePlayer: alone ? caller : null,
    upCard: null,
  };
  return beginPlay(next);
}

export function dealerDiscard(state: EuchreState, cardIndex: number): EuchreState {
  if (state.phase !== "discard") return state;
  const dealerId = state.playerIds[state.dealer];
  const hand = state.hands[dealerId];
  if (cardIndex < 0 || cardIndex >= hand.length || hand.length <= 5) return state;
  const newHand = hand.filter((_, i) => i !== cardIndex);
  return beginPlay({ ...state, hands: { ...state.hands, [dealerId]: newHand } });
}

// ----- Trick play -----
export function playCard(state: EuchreState, cardIndex: number): EuchreState {
  if (state.phase !== "playing") return state;
  const seat = state.turn;
  const pid = state.playerIds[seat];
  const hand = state.hands[pid];
  if (cardIndex < 0 || cardIndex >= hand.length) return state;
  if (!legalPlayIndices(state, seat).includes(cardIndex)) return state;

  // If the previous trick is still on screen, this play starts a fresh one.
  const baseTrick = isTrickComplete(state) ? [] : state.trick;

  const card = hand[cardIndex];
  const newHand = hand.filter((_, i) => i !== cardIndex);
  const trick = [...baseTrick, { player: seat, card }];

  let next: EuchreState = {
    ...state,
    hands: { ...state.hands, [pid]: newHand },
    trick,
  };

  if (trick.length < activeCount(state)) {
    next.turn = nextActive(state, seat);
    return next;
  }

  // Trick complete — resolve, but keep the trick visible until the winner leads.
  const ledSuit = effectiveSuit(trick[0].card, state.trump);
  let best = trick[0];
  for (const tp of trick) {
    if (trickValue(tp.card, state.trump!, ledSuit) > trickValue(best.card, state.trump!, ledSuit)) {
      best = tp;
    }
  }
  const winnerTeam = team(best.player);
  const tricks: [number, number] = [...state.tricks] as [number, number];
  tricks[winnerTeam]++;

  next = { ...next, tricks, leader: best.player, turn: best.player };

  // Hand over after 5 tricks
  if (tricks[0] + tricks[1] >= 5) {
    return scoreHand(next);
  }
  return next;
}

function scoreHand(state: EuchreState): EuchreState {
  const mk = state.makerTeam!;
  const def: 0 | 1 = mk === 0 ? 1 : 0;
  const mkTricks = state.tricks[mk];
  const scores: [number, number] = [...state.scores] as [number, number];
  let result: string;

  if (mkTricks >= 3) {
    if (mkTricks === 5) {
      const pts = state.alone ? 4 : 2;
      scores[mk] += pts;
      result = state.alone ? `Lone march! Team ${mk + 1} sweeps all 5 — +4` : `March! Team ${mk + 1} takes all 5 — +2`;
    } else {
      scores[mk] += 1;
      result = `Team ${mk + 1} made it (${mkTricks} tricks) — +1`;
    }
  } else {
    scores[def] += 2;
    result = `Euchred! Team ${def + 1} stops the makers — +2`;
  }

  let winningTeam: 0 | 1 | null = null;
  if (scores[0] >= POINTS_TO_WIN) winningTeam = 0;
  else if (scores[1] >= POINTS_TO_WIN) winningTeam = 1;

  return {
    ...state,
    scores,
    handResult: result,
    phase: winningTeam !== null ? "gameover" : "handover",
    winningTeam,
  };
}

// Deal the next hand, rotating the dealer; keeps running scores.
export function dealNextHand(state: EuchreState): EuchreState {
  const fresh = initEuchre(state.playerIds, state.stake, (state.dealer + 1) % 4);
  return {
    ...fresh,
    pot: state.pot,
    scores: state.scores,
    handNumber: state.handNumber + 1,
  };
}

// Winning team's two player ids (for the pot split)
export function winningPlayerIds(state: EuchreState): string[] {
  if (state.winningTeam === null) return [];
  return state.playerIds.filter((_, seat) => team(seat) === state.winningTeam);
}

export function teamPayoutEach(state: EuchreState): number {
  const total = Math.floor(state.pot * (1 - HOUSE_RAKE));
  return Math.floor(total / 2);
}
