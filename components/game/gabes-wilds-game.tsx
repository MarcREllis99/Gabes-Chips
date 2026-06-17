"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { PlayerAvatar } from "@/components/player-avatar";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, Trophy, Plus, SkipForward, Megaphone } from "lucide-react";
import { formatChips } from "@/lib/utils";
import {
  type WildsState,
  type WCard,
  type WColor,
  initWildsState,
  playCard,
  drawCard,
  passTurn,
  canPlay,
  topCard,
  hasPlayable,
  COLORS,
} from "@/lib/game-logic/gabes-wilds";
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

const COLOR_BG: Record<WColor, string> = {
  red: "bg-[#d62828]",
  yellow: "bg-[#f4b400]",
  green: "bg-[#138a36]",
  blue: "bg-[#1f6fde]",
};
const COLOR_TEXT: Record<WColor, string> = {
  red: "text-white",
  yellow: "text-[#1a1500]",
  green: "text-white",
  blue: "text-white",
};
const COLOR_DOT: Record<WColor, string> = {
  red: "bg-[#d62828]",
  yellow: "bg-[#f4b400]",
  green: "bg-[#138a36]",
  blue: "bg-[#1f6fde]",
};

function symbolFor(card: WCard): string {
  switch (card.kind) {
    case "number": return String(card.value);
    case "skip": return "⊘";
    case "reverse": return "⇄";
    case "draw2": return "+2";
    case "wild": return "★";
    case "wild4": return "+4";
  }
}

function WildCardView({
  card,
  size = "sm",
  faceDown = false,
  playable = false,
}: {
  card?: WCard;
  size?: "sm" | "lg";
  faceDown?: boolean;
  playable?: boolean;
}) {
  const dims = size === "lg" ? "w-20 h-28" : "w-12 h-[4.5rem]";
  const sym = size === "lg" ? "text-4xl" : "text-xl";

  if (faceDown || !card) {
    return (
      <div className={`${dims} rounded-lg bg-black border-2 border-gold-600/50 flex items-center justify-center shadow-lg`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="" className="w-2/3 h-2/3 object-contain" />
      </div>
    );
  }

  const isWild = card.kind === "wild" || card.kind === "wild4";

  if (isWild) {
    return (
      <div className={`${dims} relative rounded-lg bg-black border-2 ${playable ? "border-gold-400" : "border-gold-600/40"} flex flex-col items-center justify-center shadow-lg overflow-hidden`}>
        {/* four-color quadrants */}
        <div className="absolute inset-1 grid grid-cols-2 grid-rows-2 rounded opacity-80">
          <div className="bg-[#d62828]" />
          <div className="bg-[#f4b400]" />
          <div className="bg-[#1f6fde]" />
          <div className="bg-[#138a36]" />
        </div>
        <span className={`relative z-10 font-black text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] ${sym}`}>
          {symbolFor(card)}
        </span>
      </div>
    );
  }

  const color = card.color!;
  return (
    <div className={`${dims} relative rounded-lg ${COLOR_BG[color]} border-2 ${playable ? "border-gold-300" : "border-white/30"} flex items-center justify-center shadow-lg`}>
      <span className={`absolute top-0.5 left-1 font-bold ${COLOR_TEXT[color]} ${size === "lg" ? "text-sm" : "text-[10px]"}`}>
        {symbolFor(card)}
      </span>
      <span className={`font-black ${COLOR_TEXT[color]} ${sym}`}>{symbolFor(card)}</span>
      <span className={`absolute bottom-0.5 right-1 font-bold rotate-180 ${COLOR_TEXT[color]} ${size === "lg" ? "text-sm" : "text-[10px]"}`}>
        {symbolFor(card)}
      </span>
      {/* brand mark — screen blend drops the logo's black background on color */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo.png"
        alt=""
        className={`absolute left-1/2 -translate-x-1/2 ${size === "lg" ? "bottom-1 w-4 h-4" : "bottom-0.5 w-2.5 h-2.5"} object-contain mix-blend-screen opacity-80`}
      />
    </div>
  );
}

export function GabesWildsGame({
  game,
  lobby,
  players,
  currentUser,
  isHost,
  onGameEnd,
}: Props) {
  const [state, setState] = useState<WildsState | null>(null);
  const [pendingWildId, setPendingWildId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [iCalled, setICalled] = useState(false);
  const settledRef = useRef(false);
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>["channel"]> | null>(null);

  const supabase = createClient();
  const { toast } = useToast();
  const myId = currentUser.id;
  const nameOf = (pid: string) => players.find((p) => p.id === pid)?.username ?? "Player";

  const updateState = async (next: WildsState) => {
    setState(next);
    await supabase.from("games").update({ state: next as unknown as Record<string, unknown> }).eq("id", game.id);
  };

  const loadState = useCallback(async () => {
    const { data } = await supabase.from("games").select("state").eq("id", game.id).single();
    const existing = data?.state as Record<string, unknown> | null;
    const ready = !!existing?.phase && Array.isArray(existing?.drawPile);
    if (!ready) {
      if (isHost && players.length >= 2) {
        const ordered = [lobby.host_id, ...players.filter((p) => p.id !== lobby.host_id).map((p) => p.id)];
        const stake = (existing?.stake as number) ?? 0;
        const initial = initWildsState(ordered, stake);
        await supabase.from("games").update({ state: initial as unknown as Record<string, unknown> }).eq("id", game.id);
        setState(initial);
      }
    } else {
      setState(existing as unknown as WildsState);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id, players, isHost, lobby.host_id, supabase]);

  useEffect(() => { loadState(); }, [loadState]);

  useEffect(() => {
    const channel = supabase
      .channel(`game-gw-${game.id}`, { config: { broadcast: { self: false } } })
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${game.id}` },
        (payload) => {
          const next = payload.new.state as unknown as WildsState;
          if (Array.isArray(next?.drawPile)) setState(next);
        }
      )
      // "One More Wild" call — a live notification that doesn't touch game state
      .on("broadcast", { event: "wilds_call" }, ({ payload }) => {
        toast({
          title: "📣 One More Wild!",
          description: `${(payload as { name?: string })?.name ?? "A player"} has just one card left!`,
        });
      })
      .subscribe();
    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); channelRef.current = null; };
  }, [game.id, supabase, toast]);

  // Reset the call prompt whenever I'm no longer down to one card
  useEffect(() => {
    if ((state?.hands[myId]?.length ?? 0) !== 1) setICalled(false);
  }, [state, myId]);

  const callOneMore = () => {
    channelRef.current?.send({
      type: "broadcast",
      event: "wilds_call",
      payload: { name: nameOf(myId) },
    });
    setICalled(true);
    toast({ title: "📣 You called One More Wild!", description: "Everyone's been notified." });
  };

  // Host pays the winner once the hand ends
  useEffect(() => {
    if (!state || !isHost) return;
    if (state.phase === "finished" && state.winnerId && !settledRef.current) {
      settledRef.current = true;
      (async () => {
        setSaving(true);
        await supabase.rpc("finish_game", { p_game_id: game.id, p_winner_id: state.winnerId });
        setSaving(false);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.phase, isHost]);

  if (!state || !Array.isArray(state.drawPile)) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-gold-400" />
      </div>
    );
  }

  const myIndex = state.playerIds.indexOf(myId);
  const myHand = state.hands[myId] ?? [];
  const isMyTurn = state.turn === myIndex && myIndex >= 0;
  const top = topCard(state);
  const iHavePlayable = isMyTurn && hasPlayable(state, myIndex);
  const winner = players.find((p) => p.id === state.winnerId);

  const act = async (fn: () => WildsState) => {
    if (busy) return;
    setBusy(true);
    await updateState(fn());
    setBusy(false);
  };

  const onCardTap = (card: WCard) => {
    if (!isMyTurn || busy || state.phase !== "playing") return;
    if (!canPlay(card, top, state.currentColor)) return;
    if (card.kind === "wild" || card.kind === "wild4") {
      setPendingWildId(card.id); // ask for a color
      return;
    }
    act(() => playCard(state, card.id));
  };

  const chooseColor = (color: WColor) => {
    if (!pendingWildId) return;
    const id = pendingWildId;
    setPendingWildId(null);
    act(() => playCard(state, id, color));
  };

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="casino-card p-4 text-center">
        <h1 className="font-display text-3xl font-bold logo-gold mb-2 uppercase">Gabe&apos;s Wilds</h1>
        <div className="deco-divider max-w-[200px] mx-auto mb-2">
          <span className="text-xs">◆</span>
        </div>
        <p className="text-muted-foreground text-sm">
          Pot: <span className="text-gold-400 font-semibold">{formatChips(state.pot)} chips</span>
          {" · "}First to empty their hand wins
        </p>
      </div>

      {/* "One More Wild" call — appears whenever you're down to your last card */}
      {myIndex >= 0 && state.phase === "playing" && myHand.length === 1 && !iCalled && (
        <Button
          variant="gold"
          size="lg"
          className="w-full animate-pulse-gold"
          onClick={callOneMore}
        >
          <Megaphone className="w-5 h-5 mr-2" />
          One More Wild
        </Button>
      )}

      {/* Players strip */}
      <div className="casino-card p-3">
        <div className="flex items-center justify-between mb-2 text-xs text-muted-foreground">
          <span>Direction {state.direction === 1 ? "↻" : "↺"}</span>
          <span className="flex items-center gap-1.5">
            Active color
            <span className={`inline-block w-3.5 h-3.5 rounded-full ${COLOR_DOT[state.currentColor]} ring-1 ring-white/30`} />
          </span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {state.playerIds.map((pid, seat) => {
            const count = state.hands[pid].length;
            const isTurn = state.turn === seat && state.phase === "playing";
            return (
              <div
                key={pid}
                className={`flex flex-col items-center gap-1 p-2 rounded-lg text-center ${isTurn ? "bg-gold-500/15 ring-1 ring-gold-500/60" : "bg-black/20"}`}
              >
                <PlayerAvatar username={nameOf(pid)} userId={pid} size="sm" isHost={pid === lobby.host_id} />
                <span className="text-[11px] font-semibold truncate w-full">
                  {pid === myId ? "You" : nameOf(pid)}
                </span>
                <span className="text-[10px] text-muted-foreground">{count} card{count === 1 ? "" : "s"}</span>
                {count === 1 && (
                  <span className="text-[9px] font-black uppercase text-gold-400 tracking-wide">Wilds!</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Center: discard + draw pile */}
      <div className="casino-card felt-bg p-5">
        <div className="flex items-center justify-center gap-8">
          <div className="flex flex-col items-center gap-1">
            <WildCardView card={top} size="lg" />
            <span className="text-[10px] uppercase tracking-wide text-white/60">Discard</span>
          </div>
          <button
            type="button"
            onClick={() => isMyTurn && !state.drewThisTurn && act(() => drawCard(state))}
            disabled={!isMyTurn || state.drewThisTurn || busy || state.phase !== "playing"}
            className="flex flex-col items-center gap-1 disabled:opacity-60"
          >
            <WildCardView faceDown size="lg" />
            <span className="text-[10px] uppercase tracking-wide text-white/60">
              Draw ({state.drawPile.length})
            </span>
          </button>
        </div>
        {state.lastAction && state.phase === "playing" && (
          <p className="text-center text-xs text-white/70 mt-3">{state.lastAction}</p>
        )}
      </div>

      {/* Wild color picker */}
      {pendingWildId && (
        <div className="casino-card p-4">
          <p className="text-sm text-center text-muted-foreground mb-3">Choose the new color</p>
          <div className="grid grid-cols-4 gap-3">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => chooseColor(c)}
                className={`h-14 rounded-xl ${COLOR_BG[c]} border-2 border-white/30 active:scale-95 transition-transform`}
                aria-label={c}
              />
            ))}
          </div>
          <Button variant="ghost" size="sm" className="w-full mt-2" onClick={() => setPendingWildId(null)}>
            Cancel
          </Button>
        </div>
      )}

      {/* Result */}
      {state.phase === "finished" && winner && (
        <div className="casino-card p-6 text-center border-gold-500/40">
          <Trophy className="w-10 h-10 text-gold-400 mx-auto mb-3" />
          <h2 className="font-display text-4xl font-black logo-gold mb-2 uppercase">
            {winner.id === myId ? "You Win!" : `${winner.username} Wins!`}
          </h2>
          <p className="text-gold-400 font-semibold mb-4">
            Takes the {formatChips(state.pot)} chip pot
          </p>
          {saving && <Loader2 className="w-4 h-4 animate-spin text-gold-400 mx-auto mb-3" />}
          <Button variant="gold" size="lg" onClick={onGameEnd} disabled={saving}>
            Back to Lobby
          </Button>
        </div>
      )}

      {/* Turn controls */}
      {state.phase === "playing" && (
        <div className="casino-card p-4">
          {isMyTurn ? (
            <div className="space-y-3">
              <p className="text-sm text-center text-gold-400 font-semibold">
                Your turn — play a card{!iHavePlayable && !state.drewThisTurn ? " or draw" : ""}
              </p>
              {state.drewThisTurn && (
                <Button variant="casino" size="lg" className="w-full" onClick={() => act(() => passTurn(state))} disabled={busy}>
                  <SkipForward className="w-4 h-4 mr-2" /> Pass
                </Button>
              )}
              {!iHavePlayable && !state.drewThisTurn && (
                <Button variant="gold" size="lg" className="w-full" onClick={() => act(() => drawCard(state))} disabled={busy}>
                  <Plus className="w-4 h-4 mr-2" /> Draw a card
                </Button>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Waiting for {nameOf(state.playerIds[state.turn])}…
            </div>
          )}
        </div>
      )}

      {/* My hand */}
      {myIndex >= 0 && state.phase === "playing" && (
        <div className="casino-card p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-muted-foreground">
              Your hand ({myHand.length})
            </span>
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-2">
            {myHand.map((c) => {
              const playable = isMyTurn && canPlay(c, top, state.currentColor);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onCardTap(c)}
                  disabled={!playable || busy}
                  className={`shrink-0 transition-transform ${playable ? "hover:-translate-y-2 cursor-pointer" : "opacity-45 cursor-default"}`}
                >
                  <WildCardView card={c} size="sm" playable={playable} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      <Toaster />
    </div>
  );
}
