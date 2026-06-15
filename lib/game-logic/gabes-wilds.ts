// Gabe's Wilds — a shedding card game (match by color/number/symbol, action
// cards, wilds). First to empty their hand takes the pot. 2–8 players.

export type WColor = "red" | "yellow" | "green" | "blue";
export type WKind = "number" | "skip" | "reverse" | "draw2" | "wild" | "wild4";

export interface WCard {
  id: string;
  color: WColor | null; // null for wilds
  kind: WKind;
  value: number | null; // 0–9 for number cards, else null
}

export interface WildsState {
  phase: "playing" | "finished";
  stake: number;
  pot: number;
  playerIds: string[];
  hands: Record<string, WCard[]>;
  drawPile: WCard[];
  discard: WCard[];      // last element is the top card
  currentColor: WColor;  // the active color (chosen color after a wild)
  turn: number;          // seat index
  direction: 1 | -1;     // play order
  drewThisTurn: boolean; // current player has drawn (may play it or pass)
  winnerId: string | null;
  lastAction: string | null;
}

export const COLORS: WColor[] = ["red", "yellow", "green", "blue"];
export const HAND_SIZE = 7;

let _id = 0;
function buildDeck(): WCard[] {
  _id = 0;
  const deck: WCard[] = [];
  const mk = (color: WColor | null, kind: WKind, value: number | null) =>
    deck.push({ id: `c${_id++}`, color, kind, value });

  for (const color of COLORS) {
    mk(color, "number", 0);
    for (let v = 1; v <= 9; v++) { mk(color, "number", v); mk(color, "number", v); }
    for (const k of ["skip", "reverse", "draw2"] as WKind[]) { mk(color, k, null); mk(color, k, null); }
  }
  for (let i = 0; i < 4; i++) { mk(null, "wild", null); mk(null, "wild4", null); }

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

export function cardLabel(c: WCard): string {
  if (c.kind === "wild") return "Wild";
  if (c.kind === "wild4") return "Wild Draw Four";
  const colorName = c.color ? c.color[0].toUpperCase() + c.color.slice(1) : "";
  if (c.kind === "number") return `${colorName} ${c.value}`;
  if (c.kind === "skip") return `${colorName} Skip`;
  if (c.kind === "reverse") return `${colorName} Reverse`;
  return `${colorName} Draw Two`;
}

export function initWildsState(playerIds: string[], stake: number): WildsState {
  const deck = buildDeck();
  const hands: Record<string, WCard[]> = {};
  for (const pid of playerIds) hands[pid] = deck.splice(0, HAND_SIZE);

  // Start the discard on a plain number card (avoids first-turn action edge cases)
  const held: WCard[] = [];
  let start: WCard | undefined;
  while (deck.length) {
    const c = deck.pop()!;
    if (c.kind === "number") { start = c; break; }
    held.push(c);
  }
  // put the skipped action/wild cards back at the bottom of the draw pile
  deck.unshift(...held);

  return {
    phase: "playing",
    stake,
    pot: stake * playerIds.length,
    playerIds,
    hands,
    drawPile: deck,
    discard: [start!],
    currentColor: start!.color!,
    turn: 0,
    direction: 1,
    drewThisTurn: false,
    winnerId: null,
    lastAction: null,
  };
}

export function topCard(state: WildsState): WCard {
  return state.discard[state.discard.length - 1];
}

export function canPlay(card: WCard, top: WCard, currentColor: WColor): boolean {
  if (card.kind === "wild" || card.kind === "wild4") return true;
  if (card.color === currentColor) return true;
  if (card.kind === "number" && top.kind === "number" && card.value === top.value) return true;
  if (card.kind !== "number" && card.kind === top.kind) return true; // skip on skip, etc.
  return false;
}

export function hasPlayable(state: WildsState, seat: number): boolean {
  const top = topCard(state);
  return state.hands[state.playerIds[seat]].some((c) => canPlay(c, top, state.currentColor));
}

function nextIdx(turn: number, dir: number, steps: number, n: number): number {
  return (((turn + dir * steps) % n) + n) % n;
}

// Refill the draw pile from the discard (keeping the top) when it runs out.
function ensureDrawable(drawPile: WCard[], discard: WCard[]): { drawPile: WCard[]; discard: WCard[] } {
  if (drawPile.length > 0) return { drawPile, discard };
  const top = discard[discard.length - 1];
  const reshuffled = shuffle(discard.slice(0, -1));
  return { drawPile: reshuffled, discard: [top] };
}

// Draw `count` cards onto a player's hand, reshuffling as needed.
function drawTo(state: WildsState, pid: string, count: number): WildsState {
  let drawPile = [...state.drawPile];
  let discard = [...state.discard];
  const hand = [...state.hands[pid]];
  for (let i = 0; i < count; i++) {
    if (drawPile.length === 0) {
      const r = ensureDrawable(drawPile, discard);
      drawPile = r.drawPile;
      discard = r.discard;
      if (drawPile.length === 0) break; // nothing left to draw
    }
    hand.push(drawPile.pop()!);
  }
  return { ...state, drawPile, discard, hands: { ...state.hands, [pid]: hand } };
}

// Current player draws one card (then may play it or pass).
export function drawCard(state: WildsState): WildsState {
  if (state.phase !== "playing" || state.drewThisTurn) return state;
  const pid = state.playerIds[state.turn];
  const next = drawTo(state, pid, 1);
  return {
    ...next,
    drewThisTurn: true,
    lastAction: `${shortName(pid, state)} drew a card`,
  };
}

export function passTurn(state: WildsState): WildsState {
  if (state.phase !== "playing" || !state.drewThisTurn) return state;
  return {
    ...state,
    turn: nextIdx(state.turn, state.direction, 1, state.playerIds.length),
    drewThisTurn: false,
    lastAction: `${shortName(state.playerIds[state.turn], state)} passed`,
  };
}

function shortName(pid: string, state: WildsState): string {
  // The component overrides display with real usernames; this is a fallback.
  const i = state.playerIds.indexOf(pid);
  return `Player ${i + 1}`;
}

export function playCard(state: WildsState, cardId: string, chosenColor?: WColor): WildsState {
  if (state.phase !== "playing") return state;
  const seat = state.turn;
  const pid = state.playerIds[seat];
  const hand = state.hands[pid];
  const card = hand.find((c) => c.id === cardId);
  if (!card) return state;
  if (!canPlay(card, topCard(state), state.currentColor)) return state;
  const isWild = card.kind === "wild" || card.kind === "wild4";
  if (isWild && !chosenColor) return state; // must choose a color

  const newHand = hand.filter((c) => c.id !== cardId);
  const discard = [...state.discard, card];
  const currentColor = isWild ? chosenColor! : card.color!;
  const n = state.playerIds.length;

  let next: WildsState = {
    ...state,
    hands: { ...state.hands, [pid]: newHand },
    discard,
    currentColor,
    drewThisTurn: false,
  };

  // Win — emptied the hand
  if (newHand.length === 0) {
    return { ...next, phase: "finished", winnerId: pid, lastAction: null };
  }

  const label = card.kind === "wild" || card.kind === "wild4"
    ? `${cardLabel(card)} → ${currentColor}`
    : cardLabel(card);

  switch (card.kind) {
    case "skip": {
      const skipped = state.playerIds[nextIdx(seat, state.direction, 1, n)];
      next.turn = nextIdx(seat, state.direction, 2, n);
      next.lastAction = `${label} — ${shortName(skipped, state)} skipped`;
      break;
    }
    case "reverse": {
      const dir = (state.direction * -1) as 1 | -1;
      next.direction = dir;
      // With 2 players, reverse acts as a skip (same player goes again)
      next.turn = n === 2 ? seat : nextIdx(seat, dir, 1, n);
      next.lastAction = `${label} — direction reversed`;
      break;
    }
    case "draw2": {
      const victimSeat = nextIdx(seat, state.direction, 1, n);
      const victim = state.playerIds[victimSeat];
      next = drawTo(next, victim, 2);
      next.turn = nextIdx(seat, state.direction, 2, n);
      next.lastAction = `${label} — ${shortName(victim, state)} draws 2 & skipped`;
      break;
    }
    case "wild4": {
      const victimSeat = nextIdx(seat, state.direction, 1, n);
      const victim = state.playerIds[victimSeat];
      next = drawTo(next, victim, 4);
      next.turn = nextIdx(seat, state.direction, 2, n);
      next.lastAction = `${label} — ${shortName(victim, state)} draws 4 & skipped`;
      break;
    }
    default: {
      next.turn = nextIdx(seat, state.direction, 1, n);
      next.lastAction = label;
    }
  }

  return next;
}
