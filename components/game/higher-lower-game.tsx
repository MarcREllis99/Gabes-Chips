"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase";
import { PlayerAvatar } from "@/components/player-avatar";
import { ChipBalance } from "@/components/chip-balance";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { Toaster } from "@/components/ui/toaster";
import { Loader2, Trophy, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { formatChips } from "@/lib/utils";
import {
  type HigherLowerState,
  initHigherLowerState,
  resolveRound,
  calculatePayout,
  HOUSE_RAKE,
} from "@/lib/game-logic/higher-lower";
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

import { PlayingCard } from "./playing-card";

export function HigherLowerGame({
  game,
  lobby,
  players,
  currentUser,
  currentProfile,
  isHost,
  pot,
  onGameEnd,
}: Props) {
  const [state, setState] = useState<HigherLowerState | null>(null);
  const [saving, setSaving] = useState(false);
  const [revealing, setRevealing] = useState(false);

  const supabase = createClient();
  const { toast } = useToast();

  const host = players.find((p) => p.id === lobby.host_id);
  const guest = players.find((p) => p.id !== lobby.host_id);

  const loadState = useCallback(async () => {
    const { data } = await supabase.from("games").select("state").eq("id", game.id).single();
    const existing = data?.state as Record<string, unknown> | null;
    if (!existing || !existing.phase) {
      if (isHost && host && guest) {
        const stake = (existing?.stake as number) ?? 0;
        const initial = initHigherLowerState(host.id, guest.id, stake);
        await supabase.from("games").update({ state: initial as unknown as Record<string, unknown> }).eq("id", game.id);
        setState(initial);
      }
    } else {
      setState(existing as unknown as HigherLowerState);
    }
  }, [game.id, host, guest, isHost, supabase]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  useEffect(() => {
    const channel = supabase
      .channel(`game-hl-${game.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${game.id}` },
        (payload) => {
          setState(payload.new.state as unknown as HigherLowerState);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [game.id, supabase]);

  const updateState = async (newState: HigherLowerState) => {
    setState(newState);
    await supabase.from("games").update({ state: newState as unknown as Record<string, unknown> }).eq("id", game.id);
  };

  const handleGuess = async (guess: "higher" | "lower") => {
    if (!state) return;
    const round = state.rounds[state.currentRound];
    const newState = { ...state, rounds: [...state.rounds] };
    const newRound = { ...round };

    if (currentUser.id === state.player1Id) newRound.player1Guess = guess;
    else newRound.player2Guess = guess;

    newState.rounds[state.currentRound] = newRound;

    const bothGuessed = newRound.player1Guess && newRound.player2Guess;
    if (bothGuessed) {
      setRevealing(true);

      // Resolve now, but show the reveal (flipped card + round result)
      // for a few seconds before advancing to the next round.
      const resolved = resolveRound(newState);
      const revealState: HigherLowerState = {
        ...resolved,
        currentRound: state.currentRound,
        phase: "reveal",
        winnerId: null,
      };
      await updateState(revealState);

      setTimeout(async () => {
        await updateState(resolved);

        if (resolved.phase === "finished" && resolved.winnerId) {
          setSaving(true);
          await supabase.rpc("finish_game", { p_game_id: game.id, p_winner_id: resolved.winnerId });
          setSaving(false);
        }
        setRevealing(false);
      }, 3500);
    } else {
      await updateState(newState);
    }
  };

  if (!state || !host || !guest) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-gold-400" />
      </div>
    );
  }

  const round = state.rounds[state.currentRound];
  const myId = currentUser.id;
  const myGuess = myId === state.player1Id ? round.player1Guess : round.player2Guess;
  const oppGuess = myId === state.player1Id ? round.player2Guess : round.player1Guess;
  const winner = players.find((p) => p.id === state.winnerId);
  const myScore = myId === state.player1Id ? state.player1Score : state.player2Score;
  const oppScore = myId === state.player1Id ? state.player2Score : state.player1Score;
  const opponent = players.find((p) => p.id !== myId);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="casino-card p-4 text-center">
        <h1 className="font-display text-2xl font-bold gold-gradient mb-2 uppercase">Higher or Lower</h1>
        <div className="deco-divider max-w-[200px] mx-auto mb-2">
          <span className="text-xs">◆</span>
        </div>
        <div className="flex items-center justify-center gap-4 text-sm text-muted-foreground">
          <span>Round {state.currentRound + 1}/{state.totalRounds}</span>
          <span>·</span>
          <span>Pot: <strong className="text-gold-400">{formatChips(state.pot)}</strong></span>
          <span>·</span>
          <span>Rake: {Math.round(HOUSE_RAKE * 100)}%</span>
        </div>
      </div>

      {/* Score */}
      <div className="grid grid-cols-2 gap-4">
        {[
          { player: players.find((p) => p.id === myId)!, score: myScore, isMe: true },
          { player: opponent!, score: oppScore, isMe: false },
        ].map(({ player, score, isMe }) => player && (
          <div key={player.id} className={`casino-card p-3 text-center ${isMe ? "border-gold-500/30" : ""}`}>
            <PlayerAvatar username={player.username} userId={player.id} size="md" isHost={player.id === lobby.host_id} />
            <p className="font-semibold text-sm mt-1">{isMe ? "You" : player.username}</p>
            <p className="text-2xl font-bold text-gold-400 mt-1">{score}</p>
            <p className="text-xs text-muted-foreground">wins</p>
            <ChipBalance balance={Math.floor(state.pot / 2)} size="sm" className="mt-1" />
          </div>
        ))}
      </div>

      {/* Cards */}
      <div className="casino-card p-3 sm:p-6 felt-bg rounded-xl">
        <div className="flex items-center justify-center gap-2 sm:gap-8">
          <div className="text-center">
            <p className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wide">Current Card</p>
            <PlayingCard rank={round.currentCard.display} suit={round.currentCard.suit} size="lg" />
          </div>

          <div className="flex flex-col items-center gap-2">
            <div className="text-3xl font-bold text-gold-400">VS</div>
            {state.phase === "reveal" && round.nextCard ? (
              <div className="flex flex-col items-center">
                {round.nextCard.rank > round.currentCard.rank ? (
                  <TrendingUp className="w-8 h-8 text-green-400" />
                ) : round.nextCard.rank < round.currentCard.rank ? (
                  <TrendingDown className="w-8 h-8 text-red-400" />
                ) : (
                  <Minus className="w-8 h-8 text-yellow-400" />
                )}
              </div>
            ) : (
              <div className="w-8 h-8" />
            )}
          </div>

          <div className="text-center">
            <p className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wide">Next Card</p>
            {state.phase === "reveal" && round.nextCard ? (
              <PlayingCard rank={round.nextCard.display} suit={round.nextCard.suit} size="lg" />
            ) : (
              <PlayingCard rank="?" suit="?" faceDown size="lg" />
            )}
          </div>
        </div>

      </div>

      {/* Round result — big reveal */}
      {state.phase === "reveal" && round.nextCard && (
        <div className="casino-card p-6 text-center animate-fade-in border-gold-500/40">
          <div className="grid grid-cols-2 gap-3 mb-5">
            {[
              { id: state.player1Id, guess: round.player1Guess },
              { id: state.player2Id, guess: round.player2Guess },
            ].map(({ id, guess }) => {
              const p = players.find((pl) => pl.id === id);
              const isHigher = round.nextCard!.rank > round.currentCard.rank;
              const isTie = round.nextCard!.rank === round.currentCard.rank;
              const correct = !isTie && !!guess && (guess === "higher") === isHigher;
              return (
                <div
                  key={id}
                  className={`rounded-xl border-2 p-4 ${
                    isTie
                      ? "border-yellow-500/40 bg-yellow-500/5"
                      : correct
                        ? "border-green-500/60 bg-green-500/10"
                        : "border-red-500/40 bg-red-500/5"
                  }`}
                >
                  <p className="text-sm text-muted-foreground mb-1 truncate">
                    {id === myId ? "You" : p?.username ?? "Player"}
                  </p>
                  <p
                    className={`font-display text-2xl sm:text-3xl font-black uppercase flex items-center justify-center gap-2 ${
                      isTie ? "text-yellow-400" : correct ? "text-green-400" : "text-red-400"
                    }`}
                  >
                    {guess === "higher" ? (
                      <TrendingUp className="w-7 h-7 shrink-0" />
                    ) : (
                      <TrendingDown className="w-7 h-7 shrink-0" />
                    )}
                    {guess}
                  </p>
                </div>
              );
            })}
          </div>
          <p className="font-display text-3xl sm:text-4xl font-black uppercase gold-gradient">
            {round.roundWinner
              ? round.roundWinner === myId
                ? "You win the round!"
                : `${players.find((p) => p.id === round.roundWinner)?.username ?? "Opponent"} wins the round!`
              : "Tie — no points"}
          </p>
        </div>
      )}

      {/* Final result */}
      {state.phase === "finished" && winner && (
        <div className="casino-card p-6 text-center border-gold-500/40">
          <Trophy className="w-12 h-12 text-gold-400 mx-auto mb-3" />
          <h2 className="font-display text-4xl font-black gold-gradient mb-2 uppercase">
            {winner.id === myId ? "You Win!" : `${winner.username} Wins!`}
          </h2>
          <p className="text-muted-foreground mb-1">
            Final score: {myScore} – {oppScore}
          </p>
          <p className="text-gold-400 font-semibold">
            Payout: {formatChips(calculatePayout(state))} chips
          </p>
          {saving && <Loader2 className="w-4 h-4 animate-spin text-gold-400 mx-auto mt-2" />}
          <Button variant="gold" size="lg" className="mt-4" onClick={onGameEnd} disabled={saving}>
            Back to Lobby
          </Button>
        </div>
      )}

      {/* Guessing controls */}
      {(state.phase === "betting" || state.phase === "guessing") && (
        <div className="casino-card p-6">
          {myGuess ? (
            <div className="text-center space-y-2">
              <p className="text-muted-foreground">
                You guessed <strong className="text-foreground capitalize">{myGuess}</strong>.
              </p>
              {!oppGuess ? (
                <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Waiting for opponent...
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 text-gold-400 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Revealing...
                </div>
              )}
            </div>
          ) : (
            <div>
              <p className="font-serif text-lg font-semibold mb-4 text-center">
                Will the next card be higher or lower?
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Button
                  variant="outline"
                  size="xl"
                  onClick={() => handleGuess("higher")}
                  className="h-20 flex-col gap-1 border-green-500/40 hover:bg-green-500/10 hover:border-green-500"
                  disabled={revealing}
                >
                  <TrendingUp className="w-6 h-6 text-green-400" />
                  <span className="font-bold">Higher</span>
                </Button>
                <Button
                  variant="outline"
                  size="xl"
                  onClick={() => handleGuess("lower")}
                  className="h-20 flex-col gap-1 border-red-500/40 hover:bg-red-500/10 hover:border-red-500"
                  disabled={revealing}
                >
                  <TrendingDown className="w-6 h-6 text-red-400" />
                  <span className="font-bold">Lower</span>
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {state.phase === "reveal" && !state.winnerId && (
        <div className="casino-card p-4 text-center">
          <Loader2 className="w-5 h-5 animate-spin text-gold-400 mx-auto mb-1" />
          <p className="text-sm text-muted-foreground">
            {state.currentRound < state.totalRounds - 1 ? "Moving to next round..." : "Calculating final result..."}
          </p>
        </div>
      )}
    </div>
  );
}
