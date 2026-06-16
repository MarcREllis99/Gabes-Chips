"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { PlayerAvatar } from "@/components/player-avatar";
import { PlayingCard } from "./playing-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, Trophy, Spade, DoorClosed } from "lucide-react";
import { formatChips } from "@/lib/utils";
import {
  type HoldemState,
  initHoldemTable,
  act,
  actionInfo,
  nextHand,
  tableWinner,
} from "@/lib/game-logic/texas-holdem";
import type { Database } from "@/lib/supabase";

type Lobby = Database["public"]["Tables"]["lobbies"]["Row"];
type Game = Database["public"]["Tables"]["games"]["Row"];
type Profile = Database["public"]["Tables"]["profiles"]["Row"];

interface Props {
  game: Game;
  lobby: Lobby;
  players: Profile[];
  currentUser: { id: string };
  currentProfile: Profile;
  isHost: boolean;
  pot: number;
  onGameEnd: () => void;
}

const STREET_LABEL: Record<HoldemState["phase"], string> = {
  preflop: "Pre-Flop", flop: "The Flop", turn: "The Turn", river: "The River",
  showdown: "Showdown", handover: "Hand Over", gameover: "Game Over",
};

function arcDrop(index: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round(Math.sin((index / (count - 1)) * Math.PI) * 22);
}

export function TexasHoldemGame({ game, lobby, players, currentUser, isHost, onGameEnd }: Props) {
  const [state, setState] = useState<HoldemState | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [raiseTo, setRaiseTo] = useState("");

  const supabase = createClient();
  const { toast } = useToast();
  const myId = currentUser.id;
  const nameOf = (id: string) => players.find((p) => p.id === id)?.username ?? "Player";

  const updateState = async (next: HoldemState) => {
    setState(next);
    await supabase.from("games").update({ state: next as unknown as Record<string, unknown> }).eq("id", game.id);
  };

  const loadState = useCallback(async () => {
    const { data } = await supabase.from("games").select("state").eq("id", game.id).single();
    const existing = data?.state as Record<string, unknown> | null;
    const isTable = !!existing?.phase && Array.isArray(existing?.players) && !!existing?.stacks;
    if (!isTable) {
      if (isHost && players.length >= 2) {
        const orderedIds = [lobby.host_id, ...players.filter((p) => p.id !== lobby.host_id).map((p) => p.id)];
        const buyIn = (existing?.stake as number) ?? 0;
        const sb = Math.max(1, Math.round(buyIn / 100));
        const bb = sb * 2;
        const initial = initHoldemTable(orderedIds, buyIn, sb, bb);
        await supabase.from("games").update({ state: initial as unknown as Record<string, unknown> }).eq("id", game.id);
        setState(initial);
      }
    } else {
      setState(existing as unknown as HoldemState);
    }
  }, [game.id, players, isHost, lobby.host_id, supabase]);

  useEffect(() => { loadState(); }, [loadState]);

  useEffect(() => {
    const channel = supabase
      .channel(`game-th-${game.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${game.id}` },
        (payload) => {
          const next = payload.new.state as unknown as HoldemState;
          if (Array.isArray(next?.players) && next?.stacks) setState(next);
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [game.id, supabase]);

  const myTurn = !!state && state.toAct === myId;
  const info = state && myTurn ? actionInfo(state, myId) : null;

  // default the raise box to the min-raise whenever it becomes my turn
  const turnKey = state ? `${state.round}-${state.phase}-${state.toAct}` : "";
  const lastTurnKey = useRef("");
  useEffect(() => {
    if (myTurn && info && turnKey !== lastTurnKey.current) {
      lastTurnKey.current = turnKey;
      setRaiseTo(String(info.minRaiseTo));
    }
  }, [myTurn, info, turnKey]);

  if (!state || !Array.isArray(state.players) || !state.stacks) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-gold-400" /></div>;
  }

  const isBetting = ["preflop", "flop", "turn", "river"].includes(state.phase);
  const isShowdown = state.phase === "showdown";
  const isHandover = state.phase === "handover";
  const isGameover = state.phase === "gameover";
  const profileFor = (id: string) => players.find((p) => p.id === id);

  const doAct = async (action: "fold" | "check" | "call" | "raise", amount = 0) => {
    if (!myTurn || busy) return;
    setBusy(true);
    await updateState(act(state, myId, action, amount));
    setBusy(false);
  };
  const doRaise = async () => {
    const amt = Math.floor(Number(raiseTo));
    if (!Number.isFinite(amt)) return;
    await doAct("raise", amt);
  };
  const startNext = async () => { if (!isHost) return; await updateState(nextHand(state)); };
  const finish = async () => {
    setSaving(true);
    await supabase.rpc("finish_table_game", { p_game_id: game.id });
    setSaving(false);
    onGameEnd();
  };

  const overallWinner = isGameover ? state.winnerId : tableWinner(state);
  const seatResults = (pid: string) => state.results?.find((r) => r.winners.includes(pid));

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="bj-table px-3 sm:px-6 pt-6 pb-16 sm:pb-20 mt-3">
        {/* Board */}
        <div className="flex flex-col items-center mb-4">
          <span className="font-display text-xs font-bold uppercase tracking-[0.3em] text-gold-400/90 mb-2">♠ The Board — {STREET_LABEL[state.phase]}</span>
          <div className="flex flex-wrap justify-center gap-1.5 max-w-[320px] sm:max-w-none mx-auto min-h-[7rem] items-center">
            {Array.from({ length: 5 }).map((_, i) =>
              state.board[i]
                ? <PlayingCard key={i} rank={state.board[i].display} suit={state.board[i].suit} size="md" />
                : <PlayingCard key={i} rank="?" suit="?" faceDown size="md" />
            )}
          </div>
        </div>

        {/* Center branding + pot */}
        <div className="flex flex-col items-center text-center mb-5 select-none">
          <div className="w-9 h-9 rotate-45 bg-black/30 border border-gold-500/50 flex items-center justify-center mb-2"><Spade className="w-4 h-4 text-gold-400 -rotate-45" /></div>
          <p className="font-display text-lg sm:text-xl font-black uppercase gold-gradient leading-none">Gabe&apos;s Chips</p>
          <p className="text-[10px] tracking-[0.2em] uppercase text-white/40 mt-1">Hand {state.round} · Blinds {formatChips(state.sb)}/{formatChips(state.bb)}</p>
          <p className="mt-2 text-gold-400 font-mono font-bold text-lg">Pot {formatChips(state.pot)}</p>
        </div>

        {/* Seats */}
        <div className="flex justify-center items-start gap-2 sm:gap-3 flex-wrap">
          {state.players.map((p, i) => {
            const profile = profileFor(p.playerId);
            const isMe = p.playerId === myId;
            const isButton = state.button === p.playerId;
            const toActHere = state.toAct === p.playerId;
            const showCards = (isMe || state.reveal) && p.hole.length > 0;
            const won = (isShowdown || isHandover) && !!seatResults(p.playerId);
            const res = seatResults(p.playerId);
            return (
              <div key={p.playerId} style={{ transform: `translateY(${arcDrop(i, state.players.length)}px)` }}
                className={`flex flex-col items-center gap-1 p-2 rounded-xl ${p.folded ? "opacity-40" : ""} ${won ? "bg-gold-500/15 ring-2 ring-gold-500/70" : toActHere ? "bg-gold-500/10 ring-2 ring-gold-400/80" : isMe ? "bg-black/35 ring-1 ring-gold-500/60" : "bg-black/20"}`}>
                <div className="flex justify-center min-h-[5rem] items-center">
                  {p.hole.length === 0 ? (
                    <span className="text-white/30 text-xs">{p.stack > 0 ? "—" : "out"}</span>
                  ) : (
                    p.hole.map((card, j) => (
                      <div key={j} className={j > 0 ? "-ml-7" : ""}>
                        {showCards ? <PlayingCard rank={card.display} suit={card.suit} size="sm" highlight={won} /> : <PlayingCard rank="?" suit="?" faceDown size="sm" />}
                      </div>
                    ))
                  )}
                </div>
                {res && <span className="text-[10px] font-bold uppercase text-gold-400">{res.handName}{won && " 🏆"}</span>}
                <div className="flex items-center gap-1">
                  <PlayerAvatar username={profile?.username ?? "Player"} userId={p.playerId} size="sm" isHost={p.playerId === lobby.host_id} />
                  {isButton && <span className="text-[8px] font-bold bg-white text-black rounded-full px-1 leading-tight" title="Dealer button">D</span>}
                </div>
                <span className={`text-[11px] leading-none truncate max-w-[90px] ${isMe ? "text-gold-400 font-semibold" : "text-white/70"}`}>{isMe ? "You" : profile?.username ?? "Player"}</span>
                <span className="text-[11px] font-mono text-gold-300/90">{formatChips(p.stack)}</span>
                <div className="h-3">
                  {p.folded && p.hole.length === 0 ? null
                    : p.folded ? <span className="text-[9px] text-red-400/80">folded</span>
                    : p.allIn ? <span className="text-[9px] text-red-400 font-bold">ALL IN</span>
                    : p.committedRound > 0 ? <span className="text-[9px] font-mono text-amber-300">bet {formatChips(p.committedRound)}</span>
                    : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ===== Controls ===== */}

      {/* My turn */}
      {isBetting && myTurn && info && (
        <div className="casino-card p-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-gold-400">Your move</span>
            <span className="text-muted-foreground">Stack <span className="font-mono text-gold-400">{formatChips(info.stack)}</span>{info.toCall > 0 ? <> · To call <span className="font-mono text-amber-300">{formatChips(info.toCall)}</span></> : null}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Button variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/10" disabled={busy} onClick={() => doAct("fold")}>Fold</Button>
            {info.canCheck
              ? <Button variant="casino" disabled={busy} onClick={() => doAct("check")}>Check</Button>
              : <Button variant="casino" disabled={busy} onClick={() => doAct("call")}>Call {formatChips(info.toCall)}</Button>}
            <Button variant="gold" disabled={busy || info.maxTo <= state.currentBet} onClick={doRaise}>{state.currentBet === 0 ? "Bet" : "Raise"}</Button>
          </div>
          {info.maxTo > state.currentBet && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input type="number" inputMode="numeric" min={info.minRaiseTo} max={info.maxTo} value={raiseTo} onChange={(e) => setRaiseTo(e.target.value)} className="flex-1" />
                <span className="text-xs text-muted-foreground self-center whitespace-nowrap">raise to</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setRaiseTo(String(info.minRaiseTo))}>Min</Button>
                <Button variant="outline" size="sm" onClick={() => setRaiseTo(String(Math.min(info.maxTo, state.currentBet + state.pot)))}>Pot</Button>
                <Button variant="outline" size="sm" onClick={() => setRaiseTo(String(info.maxTo))}>All-in {formatChips(info.maxTo)}</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Not my turn */}
      {isBetting && !myTurn && (
        <div className="casino-card p-4 text-center text-sm text-muted-foreground">
          <div className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Waiting for {state.toAct ? nameOf(state.toAct) : "the table"}…</div>
          <p className="text-xs mt-1">Your hole cards are face up only to you.</p>
        </div>
      )}

      {/* Showdown / hand over */}
      {(isShowdown || isHandover) && (
        <div className="casino-card p-5 text-center space-y-2">
          {state.results?.map((r, i) => (
            <p key={i} className="text-sm">
              <span className="text-gold-400 font-semibold">{r.winners.map(nameOf).join(", ")}</span>
              {" "}{state.results!.length > 1 ? `wins ${formatChips(r.amount)}` : `takes the pot (${formatChips(r.amount)})`}
              {r.handName && r.handName !== "uncontested" ? <span className="text-white/60"> · {r.handName}</span> : isHandover ? <span className="text-white/60"> · everyone folded</span> : null}
            </p>
          ))}
          {isHost ? (
            <div className="space-y-2 pt-1">
              <Button variant="gold" size="lg" className="w-full" onClick={startNext}>Deal Next Hand</Button>
              <Button variant="outline" size="sm" className="w-full border-destructive/40 text-destructive hover:bg-destructive/10" onClick={finish} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <DoorClosed className="w-4 h-4 mr-2" />} End Game &amp; Cash Out
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm pt-1"><Loader2 className="w-4 h-4 animate-spin" /> Waiting for the host to deal the next hand…</div>
          )}
        </div>
      )}

      {/* Game over */}
      {isGameover && (
        <div className="casino-card p-6 text-center border-gold-500/40">
          <Trophy className="w-10 h-10 text-gold-400 mx-auto mb-3" />
          <h2 className="font-display text-4xl font-black gold-gradient mb-2 uppercase">
            {overallWinner === myId ? "You Win It All!" : `${nameOf(overallWinner ?? "")} Wins!`}
          </h2>
          <p className="text-muted-foreground mb-4">Took every chip on the table.</p>
          {isHost ? (
            <Button variant="gold" size="lg" onClick={finish} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Cash Out &amp; Finish</Button>
          ) : (
            <p className="text-sm text-muted-foreground">Waiting for the host to cash out…</p>
          )}
        </div>
      )}

      <Toaster />
    </div>
  );
}
