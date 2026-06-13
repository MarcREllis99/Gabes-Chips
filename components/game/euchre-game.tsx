"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { PlayingCard } from "./playing-card";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { Loader2, Trophy, Spade, Check } from "lucide-react";
import { formatChips } from "@/lib/utils";
import {
  type EuchreState,
  type Suit,
  initEuchre,
  orderUp,
  passBid,
  callTrump,
  dealerDiscard,
  playCard,
  dealNextHand,
  legalPlayIndices,
  isTrickComplete,
  trickWinnerSeat,
  team,
  partner,
  winningPlayerIds,
  teamPayoutEach,
  POINTS_TO_WIN,
} from "@/lib/game-logic/euchre";
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

const SUIT_NAME: Record<Suit, string> = { "♠": "Spades", "♥": "Hearts", "♦": "Diamonds", "♣": "Clubs" };
function suitColor(s: Suit): string {
  return s === "♥" || s === "♦" ? "text-red-400" : "text-slate-100";
}

export function EuchreGame({
  game,
  lobby,
  players,
  currentUser,
  isHost,
  onGameEnd,
}: Props) {
  const [state, setState] = useState<EuchreState | null>(null);
  const [aloneToggle, setAloneToggle] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  const supabase = createClient();
  const myId = currentUser.id;
  const dealtHandRef = useRef<number>(0);
  const settledRef = useRef(false);

  const nameOf = (seat: number) => players.find((p) => p.id === state?.playerIds[seat])?.username ?? "Player";

  const updateState = async (next: EuchreState) => {
    setState(next);
    await supabase.from("games").update({ state: next as unknown as Record<string, unknown> }).eq("id", game.id);
  };

  const loadState = useCallback(async () => {
    const { data } = await supabase.from("games").select("state").eq("id", game.id).single();
    const existing = data?.state as Record<string, unknown> | null;
    const ready = !!existing?.phase && Array.isArray(existing?.playerIds);
    if (!ready) {
      if (isHost && players.length === 4) {
        // Seat players in join order; teams are seats {0,2} vs {1,3}
        const ordered = [
          lobby.host_id,
          ...players.filter((p) => p.id !== lobby.host_id).map((p) => p.id),
        ];
        const stake = (existing?.stake as number) ?? 0;
        const initial = initEuchre(ordered, stake, 0);
        await supabase.from("games").update({ state: initial as unknown as Record<string, unknown> }).eq("id", game.id);
        setState(initial);
      }
    } else {
      setState(existing as unknown as EuchreState);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id, players, isHost, lobby.host_id, supabase]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  useEffect(() => {
    const channel = supabase
      .channel(`game-eu-${game.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${game.id}` },
        (payload) => {
          const next = payload.new.state as unknown as EuchreState;
          if (Array.isArray(next?.playerIds)) setState(next);
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [game.id, supabase]);

  // Host deals the next hand after a brief pause on handover
  useEffect(() => {
    if (!state || !isHost) return;
    if (state.phase === "handover" && dealtHandRef.current !== state.handNumber) {
      dealtHandRef.current = state.handNumber;
      const captured = state;
      const t = setTimeout(() => { updateState(dealNextHand(captured)); }, 3800);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.phase, state?.handNumber, isHost]);

  // Host settles the pot once the game is won
  useEffect(() => {
    if (!state || !isHost) return;
    if (state.phase === "gameover" && !settledRef.current) {
      settledRef.current = true;
      (async () => {
        setSaving(true);
        await supabase.rpc("finish_team_game", {
          p_game_id: game.id,
          p_winner_ids: winningPlayerIds(state),
        });
        setSaving(false);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.phase, isHost]);

  if (!state || !Array.isArray(state.playerIds)) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-gold-400" />
      </div>
    );
  }

  const myIndex = state.playerIds.indexOf(myId);
  const myTeam = myIndex >= 0 ? team(myIndex) : 0;
  const myHand = state.hands[myId] ?? [];
  const isMyTurn = state.turn === myIndex && myIndex >= 0;
  const amDealer = state.dealer === myIndex;
  const amSittingOut = state.alone && state.alonePlayer !== null && myIndex === partner(state.alonePlayer);
  const legal = isMyTurn && state.phase === "playing" ? new Set(legalPlayIndices(state, myIndex)) : new Set<number>();

  const relation = (seat: number) =>
    seat === myIndex ? "You" : seat === partner(myIndex) ? "Partner" : "Opponent";

  const act = async (fn: () => EuchreState) => {
    if (busy) return;
    setBusy(true);
    await updateState(fn());
    setAloneToggle(false);
    setBusy(false);
  };

  const myTeamScore = state.scores[myTeam];
  const oppTeamScore = state.scores[myTeam === 0 ? 1 : 0];
  const myTeamTricks = state.tricks[myTeam];
  const oppTeamTricks = state.tricks[myTeam === 0 ? 1 : 0];

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="casino-card p-4 text-center">
        <h1 className="font-display text-3xl font-bold logo-gold mb-2 uppercase">Euchre</h1>
        <div className="deco-divider max-w-[200px] mx-auto mb-2">
          <span className="text-xs">◆</span>
        </div>
        <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground flex-wrap">
          <span>Hand {state.handNumber}</span>
          <span>·</span>
          {state.trump ? (
            <span>
              Trump: <strong className={suitColor(state.trump)}>{state.trump} {SUIT_NAME[state.trump]}</strong>
            </span>
          ) : (
            <span>Trump: <strong className="text-foreground">—</strong></span>
          )}
          {state.alone && (
            <>
              <span>·</span>
              <span className="text-gold-400 font-semibold">{nameOf(state.alonePlayer!)} alone</span>
            </>
          )}
        </div>
      </div>

      {/* Scoreboard (to 10) */}
      <div className="grid grid-cols-2 gap-3">
        <div className={`casino-card p-3 text-center ${myTeam === 0 ? "border-gold-500/40" : ""}`}>
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Your Team</p>
          <p className="font-display text-3xl font-black text-gold-400">{myTeamScore}</p>
          <p className="text-xs text-muted-foreground">{myTeamTricks} trick{myTeamTricks === 1 ? "" : "s"} this hand · to {POINTS_TO_WIN}</p>
        </div>
        <div className="casino-card p-3 text-center">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Opponents</p>
          <p className="font-display text-3xl font-black text-foreground">{oppTeamScore}</p>
          <p className="text-xs text-muted-foreground">{oppTeamTricks} trick{oppTeamTricks === 1 ? "" : "s"} this hand · to {POINTS_TO_WIN}</p>
        </div>
      </div>

      {/* Players strip */}
      <div className="casino-card p-3">
        <div className="grid grid-cols-4 gap-2">
          {state.playerIds.map((pid, seat) => {
            const isTurn = state.turn === seat && (state.phase === "bidding1" || state.phase === "bidding2" || state.phase === "playing" || state.phase === "discard");
            const out = state.alone && state.alonePlayer !== null && seat === partner(state.alonePlayer);
            return (
              <div
                key={pid}
                className={`flex flex-col items-center gap-1 p-2 rounded-lg text-center ${
                  isTurn ? "bg-gold-500/15 ring-1 ring-gold-500/60" : "bg-black/20"
                } ${out ? "opacity-45" : ""}`}
              >
                <span className="text-[11px] font-semibold truncate w-full">
                  {nameOf(seat)}
                </span>
                <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                  {relation(seat)}
                </span>
                <div className="flex items-center gap-1 text-[9px]">
                  {seat === state.dealer && <span className="text-gold-400" title="Dealer">D</span>}
                  {state.caller === seat && <span title="Named trump">★</span>}
                  {out && <span title="Sitting out">💤</span>}
                  {isTurn && <span className="text-green-400">●</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Center: current trick / up card */}
      <div className="casino-card felt-bg p-4">
        {state.phase === "bidding1" && state.upCard ? (
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs uppercase tracking-[0.2em] text-gold-400/80">Up Card</p>
            <PlayingCard rank={state.upCard.display} suit={state.upCard.suit} size="md" />
          </div>
        ) : state.trick.length > 0 ? (
          <div>
            {(() => {
              const complete = isTrickComplete(state);
              const winSeat = complete ? trickWinnerSeat(state) : null;
              return (
                <>
                  <p className="text-xs uppercase tracking-[0.2em] text-gold-400/80 text-center mb-3">
                    {complete && winSeat !== null
                      ? `${winSeat === myIndex ? "You" : nameOf(winSeat)} won the trick`
                      : "Trick"}
                  </p>
                  <div className="flex justify-center gap-3 flex-wrap">
                    {state.trick.map((tp) => (
                      <div key={tp.player} className="flex flex-col items-center gap-1">
                        <PlayingCard
                          rank={tp.card.display}
                          suit={tp.card.suit}
                          size="md"
                          highlight={winSeat === tp.player}
                        />
                        <span className={`text-[10px] truncate max-w-[64px] ${winSeat === tp.player ? "text-gold-400 font-semibold" : "text-white/70"}`}>
                          {tp.player === myIndex ? "You" : nameOf(tp.player)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}
          </div>
        ) : (
          <div className="flex items-center justify-center min-h-[7rem] text-center">
            <div className="flex flex-col items-center gap-2 select-none">
              <div className="w-9 h-9 rotate-45 bg-black/30 border border-gold-500/50 flex items-center justify-center">
                <Spade className="w-4 h-4 text-gold-400 -rotate-45" />
              </div>
              <p className="font-display text-sm font-black uppercase logo-gold">Gabe&apos;s Chips</p>
              <p className="text-[10px] tracking-[0.2em] uppercase text-white/40">
                Euchre · pot {formatChips(state.pot)}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Game over */}
      {state.phase === "gameover" && state.winningTeam !== null && (
        <div className="casino-card p-6 text-center border-gold-500/40">
          <Trophy className={`w-10 h-10 mx-auto mb-3 ${state.winningTeam === myTeam ? "text-gold-400" : "text-muted-foreground"}`} />
          <h2 className="font-display text-4xl font-black logo-gold mb-2 uppercase">
            {state.winningTeam === myTeam ? "Your Team Wins!" : "Opponents Win"}
          </h2>
          <p className="text-muted-foreground mb-1">
            Final score {state.scores[myTeam]} – {state.scores[myTeam === 0 ? 1 : 0]}
          </p>
          {state.winningTeam === myTeam && (
            <p className="text-gold-400 font-semibold">You collect {formatChips(teamPayoutEach(state))} chips</p>
          )}
          {saving && <Loader2 className="w-4 h-4 animate-spin text-gold-400 mx-auto mt-2" />}
          <Button variant="gold" size="lg" className="mt-4" onClick={onGameEnd} disabled={saving}>
            Back to Lobby
          </Button>
        </div>
      )}

      {/* Hand result */}
      {state.phase === "handover" && state.handResult && (
        <div className="casino-card p-5 text-center border-gold-500/40">
          <p className="font-display text-2xl font-black logo-gold uppercase mb-1">{state.handResult}</p>
          <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Dealing the next hand…
          </div>
        </div>
      )}

      {/* Bidding round 1 */}
      {state.phase === "bidding1" && (
        <div className="casino-card p-4">
          {isMyTurn ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground text-center">
                Order up <strong className={suitColor(state.upCard!.suit)}>{state.upCard!.suit} {SUIT_NAME[state.upCard!.suit]}</strong> as trump
                {amDealer ? " (you'll pick it up)" : ""}, or pass?
              </p>
              <div className="grid grid-cols-3 gap-2">
                <Button variant="gold" onClick={() => act(() => orderUp(state, false))} disabled={busy}>
                  Order Up
                </Button>
                <Button variant="outline" className="border-gold-500/50 text-gold-400 hover:bg-gold-500/10" onClick={() => act(() => orderUp(state, true))} disabled={busy}>
                  Alone
                </Button>
                <Button variant="casino" onClick={() => act(() => passBid(state))} disabled={busy}>
                  Pass
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Waiting for {nameOf(state.turn)} to bid…
            </div>
          )}
        </div>
      )}

      {/* Bidding round 2 */}
      {state.phase === "bidding2" && (
        <div className="casino-card p-4">
          {isMyTurn ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground text-center">
                Name trump
                {state.turn === state.dealer ? " — everyone passed, dealer must call (stuck)" : ", or pass"}.
                <span className="block text-xs">Can&apos;t pick {state.turnedDownSuit} ({SUIT_NAME[state.turnedDownSuit!]}).</span>
              </p>
              <label className="flex items-center justify-center gap-2 text-sm cursor-pointer">
                <span
                  className={`w-5 h-5 rounded border flex items-center justify-center ${aloneToggle ? "bg-gold-500 border-gold-500" : "border-border"}`}
                  onClick={() => setAloneToggle((v) => !v)}
                >
                  {aloneToggle && <Check className="w-3.5 h-3.5 text-black" />}
                </span>
                <span onClick={() => setAloneToggle((v) => !v)}>Go alone</span>
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {(["♠", "♥", "♦", "♣"] as Suit[])
                  .filter((s) => s !== state.turnedDownSuit)
                  .map((s) => (
                    <Button
                      key={s}
                      variant="outline"
                      className="h-12 border-gold-500/40 hover:bg-gold-500/10"
                      onClick={() => act(() => callTrump(state, s, aloneToggle))}
                      disabled={busy}
                    >
                      <span className={`text-xl ${suitColor(s)}`}>{s}</span>
                    </Button>
                  ))}
              </div>
              {state.turn !== state.dealer && (
                <Button variant="casino" className="w-full" onClick={() => act(() => passBid(state))} disabled={busy}>
                  Pass
                </Button>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Waiting for {nameOf(state.turn)} to bid…
            </div>
          )}
        </div>
      )}

      {/* Discard (dealer) */}
      {state.phase === "discard" && !amDealer && (
        <div className="casino-card p-4 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          {nameOf(state.dealer)} is picking up and discarding…
        </div>
      )}

      {/* Sitting out notice */}
      {state.phase === "playing" && amSittingOut && (
        <div className="casino-card p-4 text-center text-sm text-muted-foreground">
          Your partner went alone — you sit this hand out. 💤
        </div>
      )}

      {/* Your hand */}
      {myIndex >= 0 && myHand.length > 0 && state.phase !== "gameover" && (
        <div className="casino-card p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-muted-foreground">Your hand</span>
            {state.phase === "discard" && amDealer && (
              <span className="text-xs text-gold-400">Tap a card to discard</span>
            )}
            {state.phase === "playing" && isMyTurn && !amSittingOut && (
              <span className="text-xs text-gold-400">Your turn — tap a card</span>
            )}
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {myHand.map((c, i) => {
              const canDiscard = state.phase === "discard" && amDealer;
              const canPlay = state.phase === "playing" && isMyTurn && !amSittingOut && legal.has(i);
              const clickable = canDiscard || canPlay;
              const dimmed = state.phase === "playing" && isMyTurn && !amSittingOut && !legal.has(i);
              return (
                <button
                  key={`${c.suit}${c.rank}`}
                  type="button"
                  disabled={!clickable || busy}
                  onClick={() => {
                    if (canDiscard) act(() => dealerDiscard(state, i));
                    else if (canPlay) act(() => playCard(state, i));
                  }}
                  className={`transition-transform ${clickable ? "hover:-translate-y-2 cursor-pointer" : "cursor-default"} ${dimmed ? "opacity-35" : ""}`}
                >
                  <PlayingCard rank={c.display} suit={c.suit} size="md" highlight={canPlay} />
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
