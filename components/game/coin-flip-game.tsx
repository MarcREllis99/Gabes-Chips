"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase";
import { PlayerAvatar } from "@/components/player-avatar";
import { ChipBalance } from "@/components/chip-balance";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { Loader2, Trophy } from "lucide-react";
import { formatChips } from "@/lib/utils";
import {
  type CoinFlipState,
  type CoinSide,
  initCoinFlipState,
  resolveCoinFlip,
  HOUSE_RAKE,
} from "@/lib/game-logic/coin-flip";
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

export function CoinFlipGame({
  game,
  lobby,
  players,
  currentUser,
  isHost,
  onGameEnd,
}: Props) {
  const [state, setState] = useState<CoinFlipState | null>(null);
  const [coinFace, setCoinFace] = useState<CoinSide>("heads");
  const [flipping, setFlipping] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const supabase = createClient();

  const host = players.find((p) => p.id === lobby.host_id);
  const guest = players.find((p) => p.id !== lobby.host_id);

  const loadState = useCallback(async () => {
    const { data } = await supabase.from("games").select("state").eq("id", game.id).single();
    const existing = data?.state as Record<string, unknown> | null;
    if (!existing || !existing.phase) {
      if (isHost && host && guest) {
        const stake = (existing?.stake as number) ?? 0;
        const initial = initCoinFlipState(host.id, guest.id, stake);
        await supabase.from("games").update({ state: initial as unknown as Record<string, unknown> }).eq("id", game.id);
        setState(initial);
      }
    } else {
      setState(existing as unknown as CoinFlipState);
    }
  }, [game.id, host, guest, isHost, supabase]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  // Realtime
  useEffect(() => {
    const channel = supabase
      .channel(`game-${game.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${game.id}` },
        (payload) => {
          const newState = payload.new.state as unknown as CoinFlipState;
          setState(newState);
          if (newState.phase === "flipping" && newState.result && !animating) {
            triggerAnimation(newState.result);
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [game.id, supabase, animating]);

  const updateState = async (newState: CoinFlipState) => {
    setState(newState);
    await supabase.from("games").update({ state: newState as unknown as Record<string, unknown> }).eq("id", game.id);
  };

  const triggerAnimation = (result: CoinSide) => {
    setAnimating(true);
    setFlipping(true);
    let flips = 0;
    const interval = setInterval(() => {
      flips++;
      setCoinFace(flips % 2 === 0 ? "heads" : "tails");
      if (flips >= 10) {
        clearInterval(interval);
        setCoinFace(result);
        setFlipping(false);
        setAnimating(false);
      }
    }, 150);
  };

  const handlePickSide = async (side: CoinSide) => {
    if (!state || !isHost || animating || state.phase !== "picking") return;

    const withSides: CoinFlipState = {
      ...state,
      hostSide: side,
      guestSide: side === "heads" ? "tails" : "heads",
    };
    const { result, winnerId } = resolveCoinFlip(withSides);
    const flippingState: CoinFlipState = {
      ...withSides,
      result,
      winnerId,
      phase: "flipping",
    };

    triggerAnimation(result);
    await updateState(flippingState);

    // Pay out once the animation has played
    setTimeout(async () => {
      setFinishing(true);
      await supabase.rpc("finish_game", { p_game_id: game.id, p_winner_id: winnerId });
      await updateState({ ...flippingState, phase: "result" });
      setFinishing(false);
    }, 2500);
  };

  if (!state || !host || !guest) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-gold-400" />
      </div>
    );
  }

  const winner = players.find((p) => p.id === state.winnerId);
  const payout = Math.floor(state.pot * (1 - HOUSE_RAKE));

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="casino-card p-6 text-center">
        <h1 className="font-display text-3xl font-bold gold-gradient mb-2 uppercase">Coin Flip</h1>
        <div className="deco-divider max-w-[200px] mx-auto mb-2">
          <span className="text-xs">◆</span>
        </div>
        <p className="text-muted-foreground text-sm">
          Stake: <span className="text-gold-400 font-semibold">{formatChips(state.stake)}</span> each
          {" · "}Pot: <span className="text-gold-400 font-semibold">{formatChips(state.pot)} chips</span>
          {" · "}Rake: {Math.round(HOUSE_RAKE * 100)}%
        </p>
      </div>

      {/* Players */}
      <div className="grid grid-cols-2 gap-4">
        {[
          { player: host, side: state.hostSide },
          { player: guest, side: state.guestSide },
        ].map(({ player, side }) => (
          <div key={player.id} className="casino-card p-4 text-center">
            <PlayerAvatar
              username={player.username}
              userId={player.id}
              size="lg"
              isHost={player.id === lobby.host_id}
            />
            <p className="font-semibold mt-2">
              {player.id === currentUser.id ? "You" : player.username}
            </p>
            <ChipBalance balance={state.stake} size="sm" className="mt-1" />
            {side && (
              <div className="mt-2">
                <span className={`text-2xl ${side === "heads" ? "text-gold-400" : "text-muted-foreground"}`}>
                  {side === "heads" ? "👑" : "🔵"}
                </span>
                <span className="text-xs text-muted-foreground block uppercase tracking-wider">{side}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Coin */}
      <div className="casino-card p-8 text-center">
        <div className={`inline-block text-7xl mb-4 ${flipping ? "animate-coin-spin" : "transition-transform duration-300"}`}>
          {coinFace === "heads" ? "🟡" : "⚫"}
        </div>
        <p className={`font-display font-black uppercase tracking-wider ${!animating && state.phase === "result" ? "text-5xl gold-gradient" : "text-2xl text-muted-foreground"}`}>
          {animating ? "Flipping..." : state.phase === "result" ? state.result : "?"}
        </p>
      </div>

      {/* Result */}
      {state.phase === "result" && winner && (
        <div className="casino-card p-6 text-center border-gold-500/40">
          <Trophy className="w-12 h-12 text-gold-400 mx-auto mb-3" />
          <h2 className="font-display text-4xl font-black gold-gradient mb-2 uppercase">
            {winner.id === currentUser.id ? "You Win!" : `${winner.username} Wins!`}
          </h2>
          <p className="text-muted-foreground">
            Result: <strong className="text-foreground">{state.result}</strong>
            {" · "}Payout: <strong className="text-gold-400">{formatChips(payout)} chips</strong>
          </p>
          {finishing && <Loader2 className="w-4 h-4 animate-spin text-gold-400 mx-auto mt-2" />}
          <Button variant="gold" size="lg" className="mt-4" onClick={onGameEnd} disabled={finishing}>
            Back to Lobby
          </Button>
        </div>
      )}

      {/* Side picking */}
      {state.phase === "picking" && (
        <div className="casino-card p-6 space-y-4">
          {isHost ? (
            <>
              <h2 className="font-serif text-lg font-semibold text-center">
                Pick your side — the flip happens immediately
              </h2>
              <div className="grid grid-cols-2 gap-3">
                <Button
                  variant="outline"
                  size="xl"
                  onClick={() => handlePickSide("heads")}
                  className="h-20 flex-col gap-1 border-gold-500/40 hover:bg-gold-500/10"
                >
                  <span className="text-3xl">👑</span>
                  <span className="font-bold">Heads</span>
                </Button>
                <Button
                  variant="outline"
                  size="xl"
                  onClick={() => handlePickSide("tails")}
                  className="h-20 flex-col gap-1 hover:bg-muted"
                >
                  <span className="text-3xl">🔵</span>
                  <span className="font-bold">Tails</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground text-center">
                {guest.username} automatically gets the other side.
              </p>
            </>
          ) : (
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Waiting for {host.username} to pick a side...
            </div>
          )}
        </div>
      )}

      {state.phase === "flipping" && (
        <div className="casino-card p-6 text-center">
          <Loader2 className="w-6 h-6 animate-spin text-gold-400 mx-auto mb-2" />
          <p className="text-muted-foreground">Flipping the coin...</p>
        </div>
      )}

      <Toaster />
    </div>
  );
}
