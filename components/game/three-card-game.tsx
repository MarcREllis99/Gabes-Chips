"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { PlayerAvatar } from "@/components/player-avatar";
import { PlayingCard } from "./playing-card";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { Loader2, Trophy, Check, X, Spade } from "lucide-react";
import { formatChips } from "@/lib/utils";
import {
  type ThreeCardState,
  type ThreeCardPlayer,
  type ThreeCardOutcome,
  initThreeCardState,
  decide,
  allDecided,
  revealDealer3,
  resolveThreeCard,
  threeCardPayout,
  handName3,
} from "@/lib/game-logic/three-card";
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

const OUTCOME_LABEL: Record<ThreeCardOutcome, string> = {
  win: "WIN",
  lose: "LOSE",
  push: "PUSH",
  blackjack: "BONUS 3:2",
};

const OUTCOME_CLASS: Record<ThreeCardOutcome, string> = {
  win: "text-green-400 bg-green-500/15 border-green-500/40",
  lose: "text-red-400 bg-red-500/15 border-red-500/40",
  push: "text-yellow-400 bg-yellow-500/15 border-yellow-500/40",
  blackjack: "text-gold-400 bg-gold-500/15 border-gold-500/60",
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
  outcome,
  stake,
  drop,
}: {
  player: ThreeCardPlayer;
  profile?: Profile;
  isMe: boolean;
  isHostPlayer: boolean;
  outcome: ThreeCardOutcome | null;
  stake: number;
  drop: number;
}) {
  const folded = player.decision === "fold";

  return (
    <div
      style={{ transform: `translateY(${drop}px)` }}
      className={`flex flex-col items-center gap-1.5 p-2 rounded-xl ${
        isMe ? "bg-black/35 ring-1 ring-gold-500/60" : "bg-black/20"
      } ${folded ? "opacity-60" : ""}`}
    >
      <div className="flex justify-center">
        {player.hand.map((card, i) => (
          <div key={i} className={i > 0 ? "-ml-8" : ""}>
            <PlayingCard rank={card.display} suit={card.suit} size="md" />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-xs font-bold uppercase tracking-wide text-white/90">
          {handName3(player.hand)}
        </span>
        {outcome ? (
          <span className={`text-[10px] font-bold border px-1.5 py-0.5 rounded-full ${OUTCOME_CLASS[outcome]}`}>
            {folded ? "FOLDED" : OUTCOME_LABEL[outcome]}
          </span>
        ) : (
          <>
            {player.decision === "play" && (
              <span className="text-[10px] font-bold text-green-400 bg-green-400/15 px-1.5 py-0.5 rounded-full">PLAYED</span>
            )}
            {folded && (
              <span className="text-[10px] font-bold text-red-400 bg-red-400/15 px-1.5 py-0.5 rounded-full">FOLDED</span>
            )}
          </>
        )}
      </div>

      {profile && (
        <PlayerAvatar username={profile.username} userId={profile.id} size="sm" isHost={isHostPlayer} />
      )}
      <span className={`text-xs leading-none truncate max-w-[110px] ${isMe ? "text-gold-400 font-semibold" : "text-white/70"}`}>
        {isMe ? "You" : profile?.username ?? "Player"}
      </span>
      {outcome && (
        <span className="text-[10px] text-white/50 leading-none">
          {outcome === "lose" ? `−${formatChips(stake)}` : `+${formatChips(threeCardPayout(outcome, stake))}`}
        </span>
      )}
    </div>
  );
}

export function ThreeCardGame({
  game,
  lobby,
  players,
  currentUser,
  isHost,
  onGameEnd,
}: Props) {
  const [state, setState] = useState<ThreeCardState | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const revealStarted = useRef(false);

  const supabase = createClient();
  const myId = currentUser.id;

  const updateState = async (newState: ThreeCardState) => {
    setState(newState);
    await supabase.from("games").update({ state: newState as unknown as Record<string, unknown> }).eq("id", game.id);
  };

  const runRevealSequence = async (s: ThreeCardState) => {
    if (revealStarted.current) return;
    revealStarted.current = true;

    const revealed = revealDealer3(s);
    await updateState(revealed);

    setTimeout(async () => {
      const resolved = resolveThreeCard(revealed);
      await updateState(resolved);

      setSaving(true);
      const results = Object.entries(resolved.results!).map(([player_id, outcome]) => ({ player_id, outcome }));
      await supabase.rpc("finish_blackjack", { p_game_id: game.id, p_results: results });
      setSaving(false);
    }, 1800);
  };

  const loadState = useCallback(async () => {
    const { data } = await supabase.from("games").select("state").eq("id", game.id).single();
    const existing = data?.state as Record<string, unknown> | null;
    const isCurrentFormat = !!existing?.phase && Array.isArray(existing?.dealerHand);
    if (!isCurrentFormat) {
      if (isHost && players.length >= 1) {
        const orderedIds = [
          lobby.host_id,
          ...players.filter((p) => p.id !== lobby.host_id).map((p) => p.id),
        ];
        const stake = (existing?.stake as number) ?? 0;
        const initial = initThreeCardState(orderedIds, stake);
        await supabase.from("games").update({ state: initial as unknown as Record<string, unknown> }).eq("id", game.id);
        setState(initial);
      }
    } else {
      setState(existing as unknown as ThreeCardState);
    }
  }, [game.id, players, isHost, lobby.host_id, supabase]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  useEffect(() => {
    const channel = supabase
      .channel(`game-3c-${game.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${game.id}` },
        (payload) => {
          const next = payload.new.state as unknown as ThreeCardState;
          if (Array.isArray(next?.dealerHand)) setState(next);
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [game.id, supabase]);

  const handleDecide = async (decision: "play" | "fold") => {
    if (!state || actionLoading || state.phase !== "deciding") return;
    setActionLoading(true);
    const newState = decide(state, myId, decision);
    await updateState(newState);
    if (allDecided(newState)) await runRevealSequence(newState);
    setActionLoading(false);
  };

  if (!state || !Array.isArray(state.dealerHand) || state.players.some((p) => !Array.isArray(p.hand))) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-gold-400" />
      </div>
    );
  }

  const me = state.players.find((p) => p.playerId === myId);
  const undecided = state.players.filter((p) => p.decision === null);
  const profileFor = (id: string) => players.find((p) => p.id === id);

  const myOutcome = state.results?.[myId] ?? null;
  const myPayout = myOutcome ? threeCardPayout(myOutcome, state.stake) : 0;
  const iFolded = me?.decision === "fold";

  return (
    <div className="space-y-4 animate-fade-in">
      {/* ===== The table ===== */}
      <div className="bj-table px-3 sm:px-6 pt-6 pb-16 sm:pb-20 mt-3">
        {/* Dealer */}
        <div className="flex flex-col items-center mb-5">
          <span className="font-display text-xs font-bold uppercase tracking-[0.3em] text-gold-400/90 mb-2">
            🎩 Dealer
          </span>
          <div className="flex justify-center">
            {state.dealerHand.map((card, i) =>
              state.dealerRevealed ? (
                <div key={i} className={i > 0 ? "-ml-8" : ""}>
                  <PlayingCard rank={card.display} suit={card.suit} size="md" />
                </div>
              ) : (
                <div key={i} className={i > 0 ? "-ml-8" : ""}>
                  <PlayingCard rank="?" suit="?" faceDown size="md" />
                </div>
              )
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            {state.dealerRevealed ? (
              <>
                <span className="text-sm font-bold uppercase tracking-wide text-white">
                  {handName3(state.dealerHand)}
                </span>
                {state.dealerQualified === false && (
                  <span className="text-[10px] font-bold text-yellow-400 bg-yellow-400/15 border border-yellow-500/40 px-2 py-0.5 rounded-full">
                    DOESN&apos;T QUALIFY
                  </span>
                )}
                {state.dealerQualified === true && (
                  <span className="text-[10px] font-bold text-white/70 bg-black/40 px-2 py-0.5 rounded-full">
                    QUALIFIES
                  </span>
                )}
              </>
            ) : (
              <span className="text-sm text-white/50 uppercase tracking-wide">
                {state.phase === "reveal" ? "Revealing…" : "Three cards face down"}
              </span>
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
            3 Card Poker
          </p>
          <p className="text-[10px] tracking-[0.2em] uppercase text-white/40 mt-1">
            Dealer plays Queen-high or better · Straight or better pays bonus · Stake {formatChips(state.stake)} each
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
              outcome={state.results?.[p.playerId] ?? null}
              stake={state.stake}
              drop={arcDrop(i, state.players.length)}
            />
          ))}
        </div>
      </div>

      {/* Decision */}
      {state.phase === "deciding" && me && (
        <div className="casino-card p-4">
          {me.decision ? (
            <div className="text-center space-y-1">
              <p className="text-muted-foreground text-sm font-medium">
                {me.decision === "play" ? "You're playing this hand." : "You folded."}
              </p>
              {undecided.length > 0 && (
                <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Waiting for {undecided.length} player{undecided.length > 1 ? "s" : ""}…
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground text-center">
                You have <strong className="text-foreground uppercase">{handName3(me.hand)}</strong> — play it against the dealer, or fold and forfeit your stake?
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Button
                  variant="gold"
                  size="lg"
                  onClick={() => handleDecide("play")}
                  disabled={actionLoading}
                  className="h-16 flex-col gap-1"
                >
                  <Check className="w-5 h-5" />
                  <span>Play</span>
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => handleDecide("fold")}
                  disabled={actionLoading}
                  className="h-16 flex-col gap-1 border-destructive/40 text-destructive hover:bg-destructive/10"
                >
                  <X className="w-5 h-5" />
                  <span>Fold</span>
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {state.phase === "reveal" && (
        <div className="casino-card p-4 text-center">
          <Loader2 className="w-5 h-5 animate-spin text-gold-400 mx-auto mb-1" />
          <p className="text-sm text-muted-foreground">Dealer reveals…</p>
        </div>
      )}

      {/* Result */}
      {state.phase === "result" && myOutcome && (
        <div className="casino-card p-6 text-center border-gold-500/40">
          <Trophy className={`w-10 h-10 mx-auto mb-3 ${myOutcome === "lose" ? "text-muted-foreground" : "text-gold-400"}`} />
          <h2 className="font-display text-4xl font-black gold-gradient mb-2 uppercase">
            {myOutcome === "blackjack" && "Bonus Win!"}
            {myOutcome === "win" && (state.dealerQualified === false ? "Dealer Doesn't Qualify!" : "You Beat the Dealer!")}
            {myOutcome === "push" && "Push"}
            {myOutcome === "lose" && (iFolded ? "Folded" : "Dealer Wins")}
          </h2>
          <p className="text-muted-foreground mb-1">
            Dealer had <strong className="text-foreground uppercase">{handName3(state.dealerHand)}</strong>
            {state.dealerQualified === false ? " — didn't qualify" : ""}
          </p>
          <p className="text-gold-400 font-semibold mb-4">
            {myOutcome === "lose"
              ? `You lose your ${formatChips(state.stake)} chip stake`
              : myOutcome === "push"
                ? `Stake returned — ${formatChips(myPayout)} chips`
                : `You collect ${formatChips(myPayout)} chips`}
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
