"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { PlayerAvatar } from "@/components/player-avatar";
import { PlayingCard } from "./playing-card";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { Loader2, Trophy, Plus, Hand, Spade } from "lucide-react";
import { formatChips } from "@/lib/utils";
import {
  type BlackjackState,
  type BlackjackPlayerHand,
  type BlackjackOutcome,
  initBlackjackState,
  hitPlayer,
  standPlayer,
  allPlayersDone,
  revealDealer,
  resolveDealer,
  handValue,
  isBlackjack,
  payoutFor,
} from "@/lib/game-logic/blackjack";
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

const OUTCOME_LABEL: Record<BlackjackOutcome, string> = {
  win: "WIN",
  lose: "LOSE",
  push: "PUSH",
  blackjack: "BJ 3:2",
};

const OUTCOME_CLASS: Record<BlackjackOutcome, string> = {
  win: "text-green-400 bg-green-500/15 border-green-500/40",
  lose: "text-red-400 bg-red-500/15 border-red-500/40",
  push: "text-yellow-400 bg-yellow-500/15 border-yellow-500/40",
  blackjack: "text-gold-400 bg-gold-500/15 border-gold-500/60",
};

// Seats hug the curved rail: edge seats sit higher, the center seat lowest.
function arcDrop(index: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round(Math.sin((index / (count - 1)) * Math.PI) * 26);
}

function Seat({
  playerHand,
  profile,
  isMe,
  isHostPlayer,
  outcome,
  stake,
  drop,
}: {
  playerHand: BlackjackPlayerHand;
  profile?: Profile;
  isMe: boolean;
  isHostPlayer: boolean;
  outcome: BlackjackOutcome | null;
  stake: number;
  drop: number;
}) {
  const value = handValue(playerHand.hand);
  const bj = isBlackjack(playerHand.hand);

  return (
    <div
      style={{ transform: `translateY(${drop}px)` }}
      className={`flex flex-col items-center gap-1.5 p-2 rounded-xl ${
        isMe ? "bg-black/35 ring-1 ring-gold-500/60" : "bg-black/20"
      }`}
    >
      {/* Cards fan toward the table center */}
      <div className="flex justify-center">
        {playerHand.hand.map((card, i) => (
          <div key={i} className={i > 0 ? "-ml-8" : ""}>
            <PlayingCard rank={card.display} suit={card.suit} size="md" highlight={value === 21} />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5">
        <span className={`text-xl font-bold leading-none ${value > 21 ? "text-red-400" : value === 21 ? "text-gold-400" : "text-white"}`}>
          {value}
        </span>
        {outcome ? (
          <span className={`text-[10px] font-bold border px-1.5 py-0.5 rounded-full ${OUTCOME_CLASS[outcome]}`}>
            {OUTCOME_LABEL[outcome]}
          </span>
        ) : (
          <>
            {bj && <span className="text-[10px] font-bold text-gold-400 bg-gold-400/15 px-1.5 py-0.5 rounded-full">BJ!</span>}
            {playerHand.busted && <span className="text-[10px] font-bold text-red-400 bg-red-400/15 px-1.5 py-0.5 rounded-full">BUST</span>}
            {playerHand.standing && !playerHand.busted && !bj && (
              <span className="text-[10px] font-bold text-blue-400 bg-blue-400/15 px-1.5 py-0.5 rounded-full">STAND</span>
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
          {outcome === "lose" ? `−${formatChips(stake)}` : `+${formatChips(payoutFor(outcome, stake))}`}
        </span>
      )}
    </div>
  );
}

export function BlackjackGame({
  game,
  lobby,
  players,
  currentUser,
  isHost,
  onGameEnd,
}: Props) {
  const [state, setState] = useState<BlackjackState | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const dealerStarted = useRef(false);

  const supabase = createClient();
  const myId = currentUser.id;
  // When set, this player banks the table (human dealer) instead of the house.
  const dealerId = lobby.dealer_id;
  const isDealerMe = !!dealerId && dealerId === myId;
  const dealerProfile = dealerId ? players.find((p) => p.id === dealerId) : undefined;

  const updateState = async (newState: BlackjackState) => {
    setState(newState);
    await supabase.from("games").update({ state: newState as unknown as Record<string, unknown> }).eq("id", game.id);
  };

  // Flip the hole card, pause, then dealer draws and everyone is scored.
  const runDealerSequence = async (s: BlackjackState) => {
    if (dealerStarted.current) return;
    dealerStarted.current = true;

    const revealed = revealDealer(s);
    await updateState(revealed);

    setTimeout(async () => {
      const resolved = resolveDealer(revealed);
      await updateState(resolved);

      setSaving(true);
      const results = Object.entries(resolved.results!).map(([player_id, outcome]) => ({ player_id, outcome }));
      if (dealerId) {
        await supabase.rpc("finish_dealer_game", { p_game_id: game.id, p_results: results });
      } else {
        await supabase.rpc("finish_blackjack", { p_game_id: game.id, p_results: results });
      }
      setSaving(false);
    }, 1800);
  };

  const loadState = useCallback(async () => {
    const { data } = await supabase.from("games").select("state").eq("id", game.id).single();
    const existing = data?.state as Record<string, unknown> | null;
    // Games saved by the old players-vs-players version have no dealerHand —
    // treat them as undealt so the host re-deals under dealer rules.
    const isCurrentFormat = !!existing?.phase && Array.isArray(existing?.dealerHand);
    if (!isCurrentFormat) {
      // Non-dealer players get seats; the human dealer (if any) is excluded.
      const seated = players.filter((p) => p.id !== dealerId);
      const orderedIds = [
        ...(seated.some((p) => p.id === lobby.host_id) ? [lobby.host_id] : []),
        ...seated.filter((p) => p.id !== lobby.host_id).map((p) => p.id),
      ];
      if (isHost && orderedIds.length >= 1) {
        const stake = (existing?.stake as number) ?? 0;
        const initial = initBlackjackState(orderedIds, stake);
        await supabase.from("games").update({ state: initial as unknown as Record<string, unknown> }).eq("id", game.id);
        setState(initial);
        // Everyone dealt naturals? Straight to the dealer.
        if (allPlayersDone(initial)) runDealerSequence(initial);
      }
    } else {
      setState(existing as unknown as BlackjackState);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id, players, isHost, lobby.host_id, dealerId, supabase]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  useEffect(() => {
    const channel = supabase
      .channel(`game-bj-${game.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${game.id}` },
        (payload) => {
          const next = payload.new.state as unknown as BlackjackState;
          if (Array.isArray(next?.dealerHand)) setState(next);
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [game.id, supabase]);

  const handleHit = async () => {
    if (!state || actionLoading || state.phase !== "playing") return;
    setActionLoading(true);
    const newState = hitPlayer(state, myId);
    await updateState(newState);
    if (allPlayersDone(newState)) await runDealerSequence(newState);
    setActionLoading(false);
  };

  const handleStand = async () => {
    if (!state || actionLoading || state.phase !== "playing") return;
    setActionLoading(true);
    const newState = standPlayer(state, myId);
    await updateState(newState);
    if (allPlayersDone(newState)) await runDealerSequence(newState);
    setActionLoading(false);
  };

  if (!state || !Array.isArray(state.dealerHand) || state.hands.some((h) => !Array.isArray(h.hand))) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-gold-400" />
      </div>
    );
  }

  const myHand = state.hands.find((ph) => ph.playerId === myId);
  const myDone = myHand ? myHand.standing || myHand.busted : true;
  const stillPlaying = state.hands.filter((ph) => !ph.standing && !ph.busted);
  const profileFor = (id: string) => players.find((p) => p.id === id);

  const myOutcome = state.results?.[myId] ?? null;
  const myPayout = myOutcome ? payoutFor(myOutcome, state.stake) : 0;

  const dealerRevealed = state.dealerRevealed;
  const dealerValue = handValue(state.dealerHand);
  const dealerUpValue = handValue([state.dealerHand[0]]);
  const dealerBJ = isBlackjack(state.dealerHand);
  const dealerBusted = dealerValue > 21;

  // When a human banks the table, their net = all antes collected − all payouts.
  let dealerNet = 0;
  if (state.results) {
    const n = Object.keys(state.results).length;
    const totalPayout = Object.values(state.results).reduce((sum, o) => sum + payoutFor(o, state.stake), 0);
    dealerNet = n * state.stake - totalPayout;
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* ===== The table ===== */}
      <div className="bj-table px-3 sm:px-6 pt-6 pb-16 sm:pb-20 mt-3">
        {/* Dealer — flat side of the table */}
        <div className="flex flex-col items-center mb-5">
          <span className="font-display text-xs font-bold uppercase tracking-[0.3em] text-gold-400/90 mb-2">
            {dealerProfile ? `👑 ${dealerProfile.username}${isDealerMe ? " (You)" : ""}` : "🎩 Dealer"}
          </span>
          <div className="flex justify-center">
            {state.dealerHand.map((card, i) =>
              i === 1 && !dealerRevealed ? (
                <div key={i} className="-ml-8">
                  <PlayingCard rank="?" suit="?" faceDown size="md" />
                </div>
              ) : (
                <div key={i} className={i > 0 ? "-ml-8" : ""}>
                  <PlayingCard
                    rank={card.display}
                    suit={card.suit}
                    size="md"
                    highlight={dealerRevealed && dealerValue === 21}
                  />
                </div>
              )
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className={`text-xl font-bold leading-none ${dealerRevealed && dealerBusted ? "text-red-400" : "text-white"}`}>
              {dealerRevealed ? dealerValue : `${dealerUpValue} + ?`}
            </span>
            {state.phase === "dealer" && (
              <span className="text-[10px] font-bold text-gold-400 bg-black/40 px-2 py-0.5 rounded-full animate-pulse">
                DRAWING…
              </span>
            )}
            {dealerRevealed && state.phase === "result" && dealerBJ && (
              <span className="text-[10px] font-bold text-gold-400 bg-gold-400/15 border border-gold-500/60 px-2 py-0.5 rounded-full">
                BLACKJACK
              </span>
            )}
            {dealerRevealed && dealerBusted && (
              <span className="text-[10px] font-bold text-red-400 bg-red-400/15 border border-red-500/40 px-2 py-0.5 rounded-full">
                BUST
              </span>
            )}
          </div>
        </div>

        {/* Center of the felt — house branding */}
        <div className="flex flex-col items-center text-center mb-6 select-none">
          <div className="w-10 h-10 rotate-45 bg-black/30 border border-gold-500/50 flex items-center justify-center mb-3">
            <Spade className="w-5 h-5 text-gold-400 -rotate-45" />
          </div>
          <p className="font-display text-xl sm:text-2xl font-black uppercase gold-gradient leading-none">
            Gabe&apos;s Chips
          </p>
          <p className="font-serif text-[11px] sm:text-xs tracking-[0.3em] uppercase text-gold-400/70 mt-2">
            Blackjack pays 3 to 2
          </p>
          <p className="text-[10px] tracking-[0.2em] uppercase text-white/40 mt-1">
            {dealerProfile ? `${dealerProfile.username} banks the table` : "Dealer must hit to 17"} · Stake {formatChips(state.stake)} each
          </p>
        </div>

        {/* Player seats — fanned along the curved rail */}
        <div className="flex justify-center items-start gap-2 sm:gap-3 flex-wrap">
          {state.hands.map((ph, i) => (
            <Seat
              key={ph.playerId}
              playerHand={ph}
              profile={profileFor(ph.playerId)}
              isMe={ph.playerId === myId}
              isHostPlayer={ph.playerId === lobby.host_id}
              outcome={state.results?.[ph.playerId] ?? null}
              stake={state.stake}
              drop={arcDrop(i, state.hands.length)}
            />
          ))}
        </div>
      </div>

      {/* ===== Below the table ===== */}

      {/* Action buttons */}
      {state.phase === "playing" && myHand && (
        <div className="casino-card p-4">
          {myDone ? (
            <div className="text-center space-y-1">
              <p className="text-muted-foreground text-sm font-medium">
                {myHand.busted
                  ? "You busted 💥"
                  : isBlackjack(myHand.hand)
                    ? "Blackjack! Waiting for the dealer…"
                    : `You're standing on ${handValue(myHand.hand)}`}
              </p>
              {stillPlaying.length > 0 && (
                <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Waiting for {stillPlaying.length} player{stillPlaying.length > 1 ? "s" : ""}…
                </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="gold"
                size="lg"
                onClick={handleHit}
                disabled={actionLoading || handValue(myHand.hand) >= 21}
                className="h-16 flex-col gap-1"
              >
                <Plus className="w-5 h-5" />
                <span>Hit</span>
              </Button>
              <Button
                variant="casino"
                size="lg"
                onClick={handleStand}
                disabled={actionLoading}
                className="h-16 flex-col gap-1"
              >
                <Hand className="w-5 h-5" />
                <span>Stand</span>
              </Button>
            </div>
          )}
        </div>
      )}

      {/* The human dealer's view while players act */}
      {state.phase === "playing" && isDealerMe && (
        <div className="casino-card p-4 text-center">
          <p className="text-sm font-medium text-gold-400">👑 You&apos;re the dealer</p>
          <p className="text-xs text-muted-foreground mt-1">
            Your hand plays itself (hit to 17) once everyone acts. You collect from players who
            bust or fall short, and pay those who beat you.
          </p>
          {stillPlaying.length > 0 && (
            <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm mt-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Waiting for {stillPlaying.length} player{stillPlaying.length > 1 ? "s" : ""}…
            </div>
          )}
        </div>
      )}

      {/* Dealer drawing */}
      {state.phase === "dealer" && (
        <div className="casino-card p-4 text-center">
          <Loader2 className="w-5 h-5 animate-spin text-gold-400 mx-auto mb-1" />
          <p className="text-sm text-muted-foreground">Dealer reveals the hole card…</p>
        </div>
      )}

      {/* Result — for the human dealer */}
      {state.phase === "result" && isDealerMe && (
        <div className="casino-card p-6 text-center border-gold-500/40">
          <Trophy className={`w-10 h-10 mx-auto mb-3 ${dealerNet < 0 ? "text-muted-foreground" : "text-gold-400"}`} />
          <h2 className="font-display text-4xl font-black gold-gradient mb-2 uppercase">
            {dealerNet > 0 ? "House Wins!" : dealerNet < 0 ? "Players Win" : "Even Table"}
          </h2>
          <p className="text-muted-foreground mb-1">
            You finished on <strong className={dealerBusted ? "text-red-400" : "text-foreground"}>{dealerValue}{dealerBusted ? " — BUST" : ""}</strong> as the dealer
          </p>
          <p className="text-gold-400 font-semibold mb-4">
            {dealerNet > 0
              ? `You collect ${formatChips(dealerNet)} chips`
              : dealerNet < 0
                ? `You pay out ${formatChips(-dealerNet)} chips`
                : "You break even"}
          </p>
          {saving && <Loader2 className="w-4 h-4 animate-spin text-gold-400 mx-auto mb-3" />}
          <Button variant="gold" size="lg" onClick={onGameEnd} disabled={saving}>
            Back to Lobby
          </Button>
        </div>
      )}

      {/* Result */}
      {state.phase === "result" && myOutcome && (
        <div className="casino-card p-6 text-center border-gold-500/40">
          <Trophy className={`w-10 h-10 mx-auto mb-3 ${myOutcome === "lose" ? "text-muted-foreground" : "text-gold-400"}`} />
          <h2 className="font-display text-4xl font-black gold-gradient mb-2 uppercase">
            {myOutcome === "blackjack" && "Blackjack!"}
            {myOutcome === "win" && "You Beat the Dealer!"}
            {myOutcome === "push" && "Push"}
            {myOutcome === "lose" && "Dealer Wins"}
          </h2>
          <p className="text-muted-foreground mb-1">
            Dealer finished on <strong className={dealerBusted ? "text-red-400" : "text-foreground"}>{dealerValue}{dealerBusted ? " — BUST" : ""}</strong>
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
