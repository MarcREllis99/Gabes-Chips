"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { PlayerAvatar } from "@/components/player-avatar";
import { PlayingCard } from "./playing-card";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { Loader2, Trophy, Swords, FastForward } from "lucide-react";
import { formatChips } from "@/lib/utils";
import {
  type WarState,
  initWarState,
  resolveBattle,
  skipToEnd,
} from "@/lib/game-logic/war";
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

export function WarGame({
  game,
  lobby,
  players,
  currentUser,
  isHost,
  onGameEnd,
}: Props) {
  const [state, setState] = useState<WarState | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const settledRef = useRef(false);

  const supabase = createClient();
  const myId = currentUser.id;
  const nameOf = (pid: string) => players.find((p) => p.id === pid)?.username ?? "Player";

  const updateState = async (next: WarState) => {
    setState(next);
    await supabase.from("games").update({ state: next as unknown as Record<string, unknown> }).eq("id", game.id);
  };

  const loadState = useCallback(async () => {
    const { data } = await supabase.from("games").select("state").eq("id", game.id).single();
    const existing = data?.state as Record<string, unknown> | null;
    const ready = !!existing?.phase && !!existing?.decks;
    if (!ready) {
      if (isHost && players.length === 2) {
        const ordered = [lobby.host_id, ...players.filter((p) => p.id !== lobby.host_id).map((p) => p.id)];
        const stake = (existing?.stake as number) ?? 0;
        const initial = initWarState(ordered, stake);
        await supabase.from("games").update({ state: initial as unknown as Record<string, unknown> }).eq("id", game.id);
        setState(initial);
      }
    } else {
      setState(existing as unknown as WarState);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id, players, isHost, lobby.host_id, supabase]);

  useEffect(() => { loadState(); }, [loadState]);

  useEffect(() => {
    const channel = supabase
      .channel(`game-war-${game.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${game.id}` },
        (payload) => {
          const next = payload.new.state as unknown as WarState;
          if (next?.decks) setState(next);
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [game.id, supabase]);

  // Host pays the winner once the war is decided
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

  if (!state || !state.decks) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-gold-400" />
      </div>
    );
  }

  // Show me on the left when I'm one of the two players
  const leftId = state.playerIds.includes(myId) ? myId : state.playerIds[0];
  const rightId = state.playerIds.find((id) => id !== leftId)!;
  const winner = players.find((p) => p.id === state.winnerId);

  const act = async (fn: () => WarState) => {
    if (busy || state.phase !== "playing") return;
    setBusy(true);
    await updateState(fn());
    setBusy(false);
  };

  const Side = ({ pid }: { pid: string }) => {
    const card = state.reveal[pid];
    const count = state.decks[pid].length;
    const wonLast = state.lastWinner === pid && state.battle > 0;
    return (
      <div className="flex flex-col items-center gap-2">
        <PlayerAvatar username={nameOf(pid)} userId={pid} size="md" isHost={pid === lobby.host_id} />
        <span className="text-xs font-semibold truncate max-w-[90px] text-center">
          {pid === myId ? "You" : nameOf(pid)}
        </span>
        <span className="text-[11px] text-muted-foreground">{count} cards</span>
        {card ? (
          <PlayingCard rank={card.display} suit={card.suit} size="md" highlight={wonLast} />
        ) : (
          <PlayingCard rank="?" suit="?" faceDown size="md" />
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="casino-card p-4 text-center">
        <h1 className="font-display text-3xl font-bold logo-gold mb-2 uppercase">War</h1>
        <div className="deco-divider max-w-[200px] mx-auto mb-2">
          <span className="text-xs">◆</span>
        </div>
        <p className="text-muted-foreground text-sm">
          Pot: <span className="text-gold-400 font-semibold">{formatChips(state.pot)} chips</span>
          {" · "}Higher card wins · Battle {state.battle}
        </p>
      </div>

      {/* Battlefield */}
      <div className="casino-card felt-bg p-5">
        <div className="flex items-start justify-center gap-5 sm:gap-8">
          <Side pid={leftId} />
          <div className="flex flex-col items-center justify-center pt-12 gap-1">
            <span className="font-display text-2xl font-black text-gold-400">VS</span>
            {state.warDepth > 0 && state.phase !== "finished" && (
              <span className="text-[10px] font-black uppercase tracking-wide text-red-400 animate-pulse flex items-center gap-1">
                <Swords className="w-3 h-3" /> War ×{state.warDepth}
              </span>
            )}
          </div>
          <Side pid={rightId} />
        </div>

        {state.battle > 0 && state.lastWinner && state.phase !== "finished" && (
          <p className="text-center text-sm text-white/80 mt-4">
            {state.lastWinner === myId ? "You take" : `${nameOf(state.lastWinner)} takes`} {state.pileSize} card{state.pileSize === 1 ? "" : "s"}
            {state.warDepth > 0 ? " after a war!" : ""}
          </p>
        )}
      </div>

      {/* Result */}
      {state.phase === "finished" && winner && (
        <div className="casino-card p-6 text-center border-gold-500/40">
          <Trophy className={`w-10 h-10 mx-auto mb-3 ${winner.id === myId ? "text-gold-400" : "text-muted-foreground"}`} />
          <h2 className="font-display text-4xl font-black logo-gold mb-2 uppercase">
            {winner.id === myId ? "You Win the War!" : `${winner.username} Wins the War!`}
          </h2>
          <p className="text-gold-400 font-semibold mb-4">
            Takes the {formatChips(Math.floor(state.pot * 0.95))} chip pot
          </p>
          {saving && <Loader2 className="w-4 h-4 animate-spin text-gold-400 mx-auto mb-3" />}
          <Button variant="gold" size="lg" onClick={onGameEnd} disabled={saving}>
            Back to Lobby
          </Button>
        </div>
      )}

      {/* Controls — either player can advance */}
      {state.phase === "playing" && (
        <div className="casino-card p-4 grid grid-cols-2 gap-3">
          <Button
            variant="gold"
            size="lg"
            className="h-14"
            onClick={() => act(() => resolveBattle(state))}
            disabled={busy}
          >
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Swords className="w-4 h-4 mr-2" />}
            Flip
          </Button>
          <Button
            variant="casino"
            size="lg"
            className="h-14"
            onClick={() => act(() => skipToEnd(state))}
            disabled={busy}
          >
            <FastForward className="w-4 h-4 mr-2" />
            Skip to Result
          </Button>
        </div>
      )}

      <Toaster />
    </div>
  );
}
