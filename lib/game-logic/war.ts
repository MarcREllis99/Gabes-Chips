// War — classic 1v1 luck game. The deck is split 26/26; each battle both
// players flip their top card, higher rank takes both. Ties trigger a "war"
// (3 down + 1 up, repeat). First to hold all 52 cards wins. A battle cap
// guarantees termination (most cards wins if it's ever hit).

import { type PCard, buildDeck } from "./poker";

export type { PCard };

export interface WarState {
  phase: "playing" | "finished";
  stake: number;
  pot: number;
  playerIds: string[]; // exactly 2
  decks: Record<string, PCard[]>;
  reveal: Record<string, PCard | null>; // last face-up card compared, per player
  pileSize: number;   // cards captured in the last battle
  warDepth: number;   // number of wars in the last battle (0 = normal)
  battle: number;
  lastWinner: string | null;
  winnerId: string | null;
}

export const MAX_BATTLES = 500;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function initWarState(playerIds: string[], stake: number): WarState {
  const deck = buildDeck(); // shuffled 52
  const [a, b] = playerIds;
  return {
    phase: "playing",
    stake,
    pot: stake * 2,
    playerIds: [a, b],
    decks: { [a]: deck.slice(0, 26), [b]: deck.slice(26, 52) },
    reveal: { [a]: null, [b]: null },
    pileSize: 0,
    warDepth: 0,
    battle: 0,
    lastWinner: null,
    winnerId: null,
  };
}

// Resolve one complete battle (including any nested wars).
export function resolveBattle(state: WarState): WarState {
  if (state.phase !== "playing") return state;
  const [a, b] = state.playerIds;
  const da = [...state.decks[a]];
  const db = [...state.decks[b]];

  if (da.length === 0 || db.length === 0) {
    return { ...state, phase: "finished", winnerId: da.length === 0 ? b : a };
  }

  const pile: PCard[] = [];
  let warDepth = 0;
  let outLoser: string | null = null;
  let winner: string | null = null;

  let up_a = da.shift()!; pile.push(up_a);
  let up_b = db.shift()!; pile.push(up_b);

  while (true) {
    if (up_a.rank > up_b.rank) { winner = a; break; }
    if (up_b.rank > up_a.rank) { winner = b; break; }

    // Tie → WAR. Each lays up to 3 face down (keeping 1 for the face-up).
    warDepth++;
    if (da.length === 0) { outLoser = a; break; }
    if (db.length === 0) { outLoser = b; break; }
    pile.push(...da.splice(0, Math.min(3, da.length - 1)));
    pile.push(...db.splice(0, Math.min(3, db.length - 1)));
    up_a = da.shift()!; pile.push(up_a);
    up_b = db.shift()!; pile.push(up_b);
  }

  if (outLoser) winner = outLoser === a ? b : a;

  // Shuffle captured cards before returning them to the bottom — keeps the
  // game from looping forever.
  const won = shuffle(pile);
  const decks: Record<string, PCard[]> = { [a]: da, [b]: db };
  decks[winner!] = [...decks[winner!], ...won];

  const battle = state.battle + 1;
  let phase: WarState["phase"] = "playing";
  let winnerId: string | null = null;

  if (decks[a].length === 0 || decks[b].length === 0) {
    phase = "finished";
    winnerId = decks[a].length === 0 ? b : a;
  } else if (battle >= MAX_BATTLES) {
    phase = "finished";
    winnerId = decks[a].length >= decks[b].length ? a : b;
  }

  return {
    ...state,
    decks,
    reveal: { [a]: up_a, [b]: up_b },
    pileSize: pile.length,
    warDepth,
    battle,
    lastWinner: winner,
    phase,
    winnerId,
  };
}

// Resolve every remaining battle at once.
export function skipToEnd(state: WarState): WarState {
  let s = state;
  let guard = 0;
  while (s.phase === "playing" && guard < MAX_BATTLES + 5) {
    s = resolveBattle(s);
    guard++;
  }
  return s;
}
