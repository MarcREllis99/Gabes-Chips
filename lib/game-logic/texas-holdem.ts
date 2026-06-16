import { type PCard, buildDeck, best7, compareScores, HAND_NAMES } from "./poker";

export type { PCard };

// ============================================================
// No-Limit Texas Hold'em — multi-round with real betting.
// Blinds + button rotate each hand; check/bet/call/raise/fold across
// preflop→flop→turn→river; all-in side pots; players eliminated at $0;
// the game ends when one player holds every chip. Turn-based (only the
// player in `toAct` acts) so there are no write races.
// ============================================================

export type HoldemPhase = "preflop" | "flop" | "turn" | "river" | "showdown" | "handover" | "gameover";

export interface HoldemPlayer {
  playerId: string;
  hole: PCard[];
  stack: number;            // chips behind
  committedRound: number;   // chips in the pot THIS street
  committedHand: number;    // chips in the pot THIS hand (for side pots)
  folded: boolean;
  allIn: boolean;
  acted: boolean;           // has acted since the last raise this street
}

export interface PotResult {
  winners: string[];
  amount: number;
  handName: string;
}

export interface HoldemState {
  phase: HoldemPhase;
  stake: number;            // buy-in (reference)
  sb: number;
  bb: number;
  round: number;            // hand number
  button: string;           // dealer-button player id
  players: HoldemPlayer[];  // stable seat order
  board: PCard[];
  deck: PCard[];
  pot: number;
  currentBet: number;       // highest committedRound this street
  minRaise: number;         // minimum raise increment
  toAct: string | null;
  lastAggressor: string | null;
  results: PotResult[] | null;
  reveal: boolean;
  message: string | null;
  winnerId: string | null;  // overall winner at gameover
  stacks: Record<string, number>; // mirror for finish_table_game
}

const clone = (s: HoldemState): HoldemState => ({
  ...s,
  players: s.players.map((p) => ({ ...p, hole: [...p.hole] })),
  board: [...s.board],
  deck: [...s.deck],
  results: s.results ? s.results.map((r) => ({ ...r, winners: [...r.winners] })) : null,
});

const recalc = (s: HoldemState): HoldemState => {
  const stacks: Record<string, number> = {};
  for (const p of s.players) stacks[p.playerId] = p.stack;
  return { ...s, stacks };
};

const idxOf = (s: HoldemState, pid: string) => s.players.findIndex((p) => p.playerId === pid);
const liveOf = (s: HoldemState) => s.players.filter((p) => !p.folded);

// Next seat (after fromIdx) that can still act this street.
function nextActable(s: HoldemState, fromIdx: number): string | null {
  const n = s.players.length;
  for (let k = 1; k <= n; k++) {
    const p = s.players[(fromIdx + k) % n];
    if (!p.folded && !p.allIn && p.stack > 0) return p.playerId;
  }
  return null;
}

function bettingComplete(s: HoldemState): boolean {
  const live = liveOf(s);
  if (live.length <= 1) return true;
  const canAct = live.filter((p) => !p.allIn && p.stack > 0);
  if (canAct.length === 0) return true; // everyone remaining is all-in
  return live.every((p) => p.allIn || (p.acted && p.committedRound === s.currentBet));
}

// ----- table lifecycle -----

export function initHoldemTable(playerIds: string[], buyIn: number, sb: number, bb: number): HoldemState {
  const players: HoldemPlayer[] = playerIds.map((playerId) => ({
    playerId, hole: [], stack: buyIn, committedRound: 0, committedHand: 0, folded: false, allIn: false, acted: false,
  }));
  const base: HoldemState = {
    phase: "preflop", stake: buyIn, sb, bb, round: 0,
    button: playerIds[playerIds.length - 1], // so the first deal puts the button on seat 0
    players, board: [], deck: [], pot: 0, currentBet: 0, minRaise: bb,
    toAct: null, lastAggressor: null, results: null, reveal: false, message: null, winnerId: null, stacks: {},
  };
  return startHand(base);
}

// Begin a fresh hand: rotate the button, post blinds, deal hole cards.
export function startHand(prev: HoldemState): HoldemState {
  const s = clone(prev);
  const eligible = s.players.filter((p) => p.stack > 0);
  if (eligible.length <= 1) {
    return recalc({ ...s, phase: "gameover", winnerId: eligible[0]?.playerId ?? null, toAct: null, results: null, message: null });
  }

  // rotate button to the next eligible seat
  const n = s.players.length;
  let bi = idxOf(s, s.button);
  for (let k = 1; k <= n; k++) {
    const cand = s.players[(bi + k) % n];
    if (cand.stack > 0) { bi = (bi + k) % n; break; }
  }
  s.button = s.players[bi].playerId;

  for (const p of s.players) {
    p.hole = [];
    p.committedRound = 0;
    p.committedHand = 0;
    p.allIn = false;
    p.acted = false;
    p.folded = p.stack <= 0; // eliminated players sit the hand out
  }

  const deck = buildDeck();
  for (const p of s.players) if (!p.folded) { p.hole = [deck.pop()!, deck.pop()!]; }
  s.deck = deck;
  s.board = [];
  s.pot = 0;
  s.results = null;
  s.reveal = false;
  s.message = null;
  s.currentBet = 0;
  s.minRaise = s.bb;
  s.phase = "preflop";
  s.round = s.round + 1;

  // seat order of eligible players, starting left of the button
  const order: number[] = [];
  for (let k = 1; k <= n; k++) {
    const j = (bi + k) % n;
    if (s.players[j].stack > 0) order.push(j);
  }
  let sbIdx: number, bbIdx: number;
  if (order.length === 2) {
    sbIdx = bi;           // heads-up: button posts the small blind
    bbIdx = order[0] === bi ? order[1] : order[0];
  } else {
    sbIdx = order[0];
    bbIdx = order[1];
  }

  const post = (p: HoldemPlayer, amt: number) => {
    const pay = Math.min(amt, p.stack);
    p.stack -= pay; p.committedRound += pay; p.committedHand += pay;
    if (p.stack === 0) p.allIn = true;
    s.pot += pay;
  };
  post(s.players[sbIdx], s.sb);
  post(s.players[bbIdx], s.bb);
  s.currentBet = Math.max(s.players[sbIdx].committedRound, s.players[bbIdx].committedRound);
  s.minRaise = s.bb;
  s.lastAggressor = s.players[bbIdx].playerId;

  // first to act preflop = left of the big blind
  s.toAct = nextActable(s, bbIdx);
  // if nobody can act (everyone all-in from blinds), run it out
  if (s.toAct === null) return recalc(runOut(s));
  return recalc(s);
}

// ----- actions -----

export interface ActionInfo {
  toCall: number;       // chips needed to call
  canCheck: boolean;
  minRaiseTo: number;   // smallest legal "raise to" total this street
  maxTo: number;        // all-in total this street
  stack: number;
}

export function actionInfo(s: HoldemState, pid: string): ActionInfo {
  const p = s.players[idxOf(s, pid)];
  if (!p) return { toCall: 0, canCheck: true, minRaiseTo: 0, maxTo: 0, stack: 0 };
  const toCall = Math.min(s.currentBet - p.committedRound, p.stack);
  return {
    toCall,
    canCheck: s.currentBet === p.committedRound,
    minRaiseTo: Math.min(s.currentBet + s.minRaise, p.committedRound + p.stack),
    maxTo: p.committedRound + p.stack,
    stack: p.stack,
  };
}

export type HoldemAction = "fold" | "check" | "call" | "raise";

// Apply one action by `pid`. For "raise", `amount` is the TOTAL committed this
// street after raising (i.e. "raise to amount"). Auto-advances streets / runs
// the hand out when the betting round is complete.
export function act(prev: HoldemState, pid: string, action: HoldemAction, amount = 0): HoldemState {
  if (!["preflop", "flop", "turn", "river"].includes(prev.phase)) return prev;
  if (prev.toAct !== pid) return prev;
  const s = clone(prev);
  const i = idxOf(s, pid);
  const p = s.players[i];
  if (!p || p.folded || p.allIn) return prev;

  if (action === "fold") {
    p.folded = true;
    p.acted = true;
  } else if (action === "check") {
    if (p.committedRound !== s.currentBet) return prev; // illegal
    p.acted = true;
  } else if (action === "call") {
    const need = Math.min(s.currentBet - p.committedRound, p.stack);
    p.stack -= need; p.committedRound += need; p.committedHand += need; s.pot += need;
    if (p.stack === 0) p.allIn = true;
    p.acted = true;
  } else if (action === "raise") {
    const total = Math.floor(amount);
    const pay = total - p.committedRound;
    const allInTotal = p.committedRound + p.stack;
    if (pay <= 0 || pay > p.stack) return prev;
    const isAllIn = total === allInTotal;
    // must exceed the current bet; a full raise is >= minRaise, all-in may be short
    if (total <= s.currentBet) return prev;
    if (total < s.currentBet + s.minRaise && !isAllIn) return prev;
    p.stack -= pay; p.committedRound += pay; p.committedHand += pay; s.pot += pay;
    if (p.stack === 0) p.allIn = true;
    const raiseSize = total - s.currentBet;
    if (raiseSize >= s.minRaise) s.minRaise = raiseSize; // a full raise sets the new bar
    s.currentBet = total;
    s.lastAggressor = pid;
    // re-open action for everyone else still in
    for (const o of s.players) if (o.playerId !== pid && !o.folded && !o.allIn) o.acted = false;
    p.acted = true;
  }

  // Everyone folded but one → award immediately.
  if (liveOf(s).length <= 1) return recalc(awardFolded(s));

  if (bettingComplete(s)) return recalc(advance(s));

  s.toAct = nextActable(s, i);
  if (s.toAct === null) return recalc(advance(s));
  return recalc(s);
}

function awardFolded(s: HoldemState): HoldemState {
  const winner = liveOf(s)[0];
  winner.stack += s.pot;
  return {
    ...s,
    phase: "handover",
    reveal: false,
    toAct: null,
    results: [{ winners: [winner.playerId], amount: s.pot, handName: "uncontested" }],
    message: "everyone folded",
  };
}

// Move to the next street; deal the board; run straight to showdown if no one
// can act anymore (all-in situations).
function advance(s: HoldemState): HoldemState {
  if (liveOf(s).length <= 1) return awardFolded(s);

  // reset the street
  for (const p of s.players) { p.committedRound = 0; p.acted = false; }
  s.currentBet = 0;
  s.minRaise = s.bb;

  if (s.phase === "preflop") { s.board.push(s.deck.pop()!, s.deck.pop()!, s.deck.pop()!); s.phase = "flop"; }
  else if (s.phase === "flop") { s.board.push(s.deck.pop()!); s.phase = "turn"; }
  else if (s.phase === "turn") { s.board.push(s.deck.pop()!); s.phase = "river"; }
  else if (s.phase === "river") return showdown(s);

  const bi = idxOf(s, s.button);
  s.toAct = nextActable(s, bi);
  if (s.toAct === null) return advance(s); // nobody can act → keep dealing
  return s;
}

// Deal any missing board cards, then run the showdown.
function runOut(s: HoldemState): HoldemState {
  for (const p of s.players) { p.committedRound = 0; p.acted = false; }
  s.currentBet = 0;
  while (s.board.length < 5 && liveOf(s).length > 1) {
    if (s.board.length < 3) s.board.push(s.deck.pop()!, s.deck.pop()!, s.deck.pop()!);
    else s.board.push(s.deck.pop()!);
  }
  return showdown(s);
}

// Build side pots from each player's hand contribution and award them.
function showdown(s: HoldemState): HoldemState {
  s.reveal = true;
  s.toAct = null;

  let contribs = s.players
    .map((p) => ({ pid: p.playerId, amt: p.committedHand, folded: p.folded }))
    .filter((c) => c.amt > 0);

  const pots: { amount: number; eligible: string[] }[] = [];
  while (contribs.length > 0) {
    const min = Math.min(...contribs.map((c) => c.amt));
    const amount = min * contribs.length;
    const eligible = contribs.filter((c) => !c.folded).map((c) => c.pid);
    if (eligible.length > 0) pots.push({ amount, eligible });
    else if (pots.length > 0) pots[pots.length - 1].amount += amount; // dead chips fold into prior pot
    contribs = contribs.map((c) => ({ ...c, amt: c.amt - min })).filter((c) => c.amt > 0);
  }

  const results: PotResult[] = [];
  const scoreCache: Record<string, number[]> = {};
  const scoreFor = (pid: string) => {
    if (!scoreCache[pid]) {
      const p = s.players[idxOf(s, pid)];
      scoreCache[pid] = best7([...p.hole, ...s.board]);
    }
    return scoreCache[pid];
  };

  for (const pot of pots) {
    let best: number[] | null = null;
    let winners: string[] = [];
    // seat order for deterministic odd-chip assignment
    for (const p of s.players) {
      if (!pot.eligible.includes(p.playerId)) continue;
      const sc = scoreFor(p.playerId);
      if (!best || compareScores(sc, best) > 0) { best = sc; winners = [p.playerId]; }
      else if (compareScores(sc, best) === 0) winners.push(p.playerId);
    }
    const each = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - each * winners.length;
    for (const w of winners) {
      const extra = remainder > 0 ? 1 : 0;
      if (remainder > 0) remainder--;
      s.players[idxOf(s, w)].stack += each + extra;
    }
    results.push({ winners, amount: pot.amount, handName: best ? HAND_NAMES[best[0]] : "" });
  }

  s.results = results;
  s.phase = "showdown";
  s.message = null;
  return s;
}

// Host advances to the next hand (or ends the game).
export function nextHand(s: HoldemState): HoldemState {
  return startHand(s);
}

export function tableWinner(s: HoldemState): string | null {
  const withChips = s.players.filter((p) => p.stack > 0);
  return withChips.length === 1 ? withChips[0].playerId : null;
}
