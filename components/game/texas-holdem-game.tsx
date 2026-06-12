"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase";
import { PlayerAvatar } from "@/components/player-avatar";
import { PlayingCard } from "./playing-card";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { Loader2, Trophy, Spade, Layers } from "lucide-react";
import { formatChips } from "@/lib/utils";
import {
  type HoldemState,
  type HoldemPlayer,
  initHoldemState,
  advanceStreet,
  holdemPayout,
  NEXT_STREET_LABEL,
  HOUSE_RAKE,
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
  preflop: "Pre-Flop",
  flop: "The Flop",
  turn: "The Turn",
  river: "The River",
  showdown: "Showdown",
};

function arcDrop(index: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round(Math.sin((index / (count - 1)) * Math.PI) * 26);
}

function Seat({
  player,
  profile,
  isMe,
  isHostPlayer,
  isWinner,
  showCards,
  handName,
  drop,
}: {
  player: HoldemPlayer;
  profile?: Profile;
  isMe: boolean;
  isHostPlayer: boolean;
  isWinner: boolean;
  showCards: boolean;
  handName: string | null;
  drop: number;
}) {
  return (
    <div
      style={{ transform: `translateY(${drop}px)` }}
      className={`flex flex-col items-center gap-1.5 p-2 rounded-xl ${
        isWinner
          ? "bg-gold-500/15 ring-2 ring-gold-500/70"
          : isMe
            ? "bg-black/35 ring-1 ring-gold-500/60"
            : "bg-black/20"
      }`}
    >
      <div className="flex justify-center">
        {player.hole.map((card, i) => (
          <div key={i} className={i > 0 ? "-ml-8" : ""}>
            {showCards ? (
              <PlayingCard rank={card.display} suit={card.suit} size="md" highlight={isWinner} />
            ) : (
              <PlayingCard rank="?" suit="?" faceDown size="md" />
            )}
          </div>
        ))}
      </div>

      {handName && (
        <span className={`text-xs font-bold uppercase tracking-wide ${isWinner ? "text-gold-400" : "text-white/80"}`}>
          {handName}
          {isWinner && " 🏆"}
        </span>
      )}

      {profile && (
        <PlayerAvatar username={profile.username} userId={profile.id} size="sm" isHost={isHostPlayer} />
      )}
      <span className={`text-xs leading-none truncate max-w-[110px] ${isMe ? "text-gold-400 font-semibold" : "text-white/70"}`}>
        {isMe ? "You" : profile?.username ?? "Player"}
      </span>
    </div>
  );
}

export function TexasHoldemGame({
  game,
  lobby,
  players,
  currentUser,
  isHost,
  onGameEnd,
}: Props) {
  const [state, setState] = useState<HoldemState | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const supabase = createClient();
  const myId = currentUser.id;

  const updateState = async (newState: HoldemState) => {
    setState(newState);
    await supabase.from("games").update({ state: newState as unknown as Record<string, unknown> }).eq("id", game.id);
  };

  const loadState = useCallback(async () => {
    const { data } = await supabase.from("games").select("state").eq("id", game.id).single();
    const existing = data?.state as Record<string, unknown> | null;
    const isCurrentFormat = !!existing?.phase && Array.isArray(existing?.board);
    if (!isCurrentFormat) {
      if (isHost && players.length >= 2) {
        const orderedIds = [
          lobby.host_id,
          ...players.filter((p) => p.id !== lobby.host_id).map((p) => p.id),
        ];
        const stake = (existing?.stake as number) ?? 0;
        const initial = initHoldemState(orderedIds, stake);
        await supabase.from("games").update({ state: initial as unknown as Record<string, unknown> }).eq("id", game.id);
        setState(initial);
      }
    } else {
      setState(existing as unknown as HoldemState);
    }
  }, [game.id, players, isHost, lobby.host_id, supabase]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  useEffect(() => {
    const channel = supabase
      .channel(`game-th-${game.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${game.id}` },
        (payload) => {
          const next = payload.new.state as unknown as HoldemState;
          if (Array.isArray(next?.board)) setState(next);
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [game.id, supabase]);

  const handleAdvance = async () => {
    if (!state || !isHost || actionLoading || state.phase === "showdown") return;
    setActionLoading(true);

    const next = advanceStreet(state);
    await updateState(next);

    if (next.phase === "showdown" && next.winnerId) {
      setSaving(true);
      await supabase.rpc("finish_game", { p_game_id: game.id, p_winner_id: next.winnerId });
      setSaving(false);
    }
    setActionLoading(false);
  };

  if (!state || !Array.isArray(state.board) || state.players.some((p) => !Array.isArray(p.hole))) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-gold-400" />
      </div>
    );
  }

  const profileFor = (id: string) => players.find((p) => p.id === id);
  const winner = players.find((p) => p.id === state.winnerId);
  const payout = holdemPayout(state.pot);
  const isShowdown = state.phase === "showdown";

  return (
    <div className="space-y-4 animate-fade-in">
      {/* ===== The table ===== */}
      <div className="bj-table px-3 sm:px-6 pt-6 pb-16 sm:pb-20 mt-3">
        {/* The board — where the dealer would stand */}
        <div className="flex flex-col items-center mb-5">
          <span className="font-display text-xs font-bold uppercase tracking-[0.3em] text-gold-400/90 mb-2">
            ♠ The Board — {STREET_LABEL[state.phase]}
          </span>
          <div className="flex flex-wrap justify-center gap-1.5 max-w-[320px] sm:max-w-none mx-auto">
            {Array.from({ length: 5 }).map((_, i) =>
              state.board[i] ? (
                <PlayingCard
                  key={i}
                  rank={state.board[i].display}
                  suit={state.board[i].suit}
                  size="md"
                />
              ) : (
                <PlayingCard key={i} rank="?" suit="?" faceDown size="md" />
              )
            )}
          </div>
        </div>

        {/* Center branding */}
        <div className="flex flex-col items-center text-center mb-6 select-none">
          <div className="w-10 h-10 rotate-45 bg-black/30 border border-gold-500/50 flex items-center justify-center mb-3">
            <Spade className="w-5 h-5 text-gold-400 -rotate-45" />
          </div>
          <p className="font-display text-xl sm:text-2xl font-black uppercase gold-gradient leading-none">
            Gabe&apos;s Chips
          </p>
          <p className="font-serif text-[11px] sm:text-xs tracking-[0.3em] uppercase text-gold-400/70 mt-2">
            Texas Hold&apos;em
          </p>
          <p className="text-[10px] tracking-[0.2em] uppercase text-white/40 mt-1">
            Everyone&apos;s in — best hand takes the pot · Pot {formatChips(state.pot)} chips
          </p>
        </div>

        {/* Seats */}
        <div className="flex justify-center items-start gap-2 sm:gap-3 flex-wrap">
          {state.players.map((p, i) => (
            <Seat
              key={p.playerId}
              player={p}
              profile={profileFor(p.playerId)}
              isMe={p.playerId === myId}
              isHostPlayer={p.playerId === lobby.host_id}
              isWinner={isShowdown && state.winnerId === p.playerId}
              showCards={p.playerId === myId || isShowdown}
              handName={isShowdown ? state.showdown?.[p.playerId]?.name ?? null : null}
              drop={arcDrop(i, state.players.length)}
            />
          ))}
        </div>
      </div>

      {/* Dealing controls */}
      {!isShowdown && (
        <div className="casino-card p-4 text-center">
          {isHost ? (
            <Button
              variant="gold"
              size="lg"
              onClick={handleAdvance}
              disabled={actionLoading}
              className="w-full sm:w-auto px-10"
            >
              {actionLoading ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Layers className="w-4 h-4 mr-2" />
              )}
              {NEXT_STREET_LABEL[state.phase]}
            </Button>
          ) : (
            <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Waiting for the host to deal…
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-2">
            Your hole cards are face up only to you — everyone shows at the showdown.
          </p>
        </div>
      )}

      {/* Result */}
      {isShowdown && winner && (
        <div className="casino-card p-6 text-center border-gold-500/40">
          <Trophy className="w-10 h-10 text-gold-400 mx-auto mb-3" />
          <h2 className="font-display text-4xl font-black gold-gradient mb-2 uppercase">
            {winner.id === myId ? "You Win!" : `${winner.username} Wins!`}
          </h2>
          <p className="text-muted-foreground mb-1">
            Winning hand: <strong className="text-foreground uppercase">{state.winnerHandName}</strong>
          </p>
          <p className="text-gold-400 font-semibold mb-4">
            Pot: {formatChips(state.pot)} chips · Payout {formatChips(payout)} (−{Math.round(HOUSE_RAKE * 100)}% rake)
          </p>
          {saving && <Loader2 className="w-4 h-4 animate-spin text-gold-400 mx-auto mb-3" />}
          <Button variant="gold" size="lg" onClick={onGameEnd} disabled={saving}>
            Back to Lobby
          </Button>
        </div>
      )}

      <Toaster />
    </div>
  );
}
