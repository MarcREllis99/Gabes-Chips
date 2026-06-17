"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { PlayerAvatar } from "@/components/player-avatar";
import { PlayingCard } from "./playing-card";
import { Button } from "@/components/ui/button";
import { Chip, ChipStack, denomsForBuyIn } from "./poker-chips";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, Trophy, Check, X, Spade, Coins, DoorClosed } from "lucide-react";
import { formatChips } from "@/lib/utils";
import {
  type ThreeCardState,
  type ThreeCardOutcome,
  initThreeCardTable,
  setAnte,
  anyAnte,
  dealThreeCard,
  decide,
  allDecided,
  revealDealer3,
  resolveThreeCard,
  nextRound,
  threeCardPayout,
  handName3,
  survivors,
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

const OUTCOME_LABEL: Record<ThreeCardOutcome, string> = { win: "WIN", lose: "LOSE", push: "PUSH", blackjack: "BONUS 3:2" };
const OUTCOME_CLASS: Record<ThreeCardOutcome, string> = {
  win: "text-green-400 bg-green-500/15 border-green-500/40",
  lose: "text-red-400 bg-red-500/15 border-red-500/40",
  push: "text-yellow-400 bg-yellow-500/15 border-yellow-500/40",
  blackjack: "text-gold-400 bg-gold-500/15 border-gold-500/60",
};

function arcDrop(index: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round(Math.sin((index / (count - 1)) * Math.PI) * 22);
}

export function ThreeCardGame({ game, lobby, players, currentUser, isHost, onGameEnd }: Props) {
  const [state, setState] = useState<ThreeCardState | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [anteTray, setAnteTray] = useState<Record<number, number>>({});
  const resolveRef = useRef(false);

  const supabase = createClient();
  const { toast } = useToast();
  const myId = currentUser.id;
  const amBoss = isHost;
  const nameOf = (id: string) => players.find((p) => p.id === id)?.username ?? "Player";

  const updateState = async (next: ThreeCardState) => {
    setState(next);
    await supabase.from("games").update({ state: next as unknown as Record<string, unknown> }).eq("id", game.id);
  };

  const loadState = useCallback(async () => {
    const { data } = await supabase.from("games").select("state").eq("id", game.id).single();
    const existing = data?.state as Record<string, unknown> | null;
    const isTable = !!existing?.phase && !!existing?.stacks;
    if (!isTable) {
      if (amBoss) {
        const orderedIds = [lobby.host_id, ...players.filter((p) => p.id !== lobby.host_id).map((p) => p.id)];
        const buyIn = (existing?.stake as number) ?? 0;
        const initial = initThreeCardTable(orderedIds, buyIn);
        await supabase.from("games").update({ state: initial as unknown as Record<string, unknown> }).eq("id", game.id);
        setState(initial);
      }
    } else {
      setState(existing as unknown as ThreeCardState);
    }
  }, [game.id, players, amBoss, lobby.host_id, supabase]);

  useEffect(() => { loadState(); }, [loadState]);

  useEffect(() => {
    const channel = supabase
      .channel(`game-3c-${game.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${game.id}` },
        (payload) => {
          const next = payload.new.state as unknown as ThreeCardState;
          if (next?.stacks) setState(next);
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [game.id, supabase]);

  // The host reveals the dealer + settles once everyone has decided.
  useEffect(() => {
    if (!state || !amBoss) return;
    if (state.phase === "deciding" && allDecided(state) && !resolveRef.current) {
      resolveRef.current = true;
      (async () => {
        const revealed = revealDealer3(state);
        await updateState(revealed);
        setTimeout(async () => { await updateState(resolveThreeCard(revealed)); }, 1200);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, amBoss]);

  if (!state || !state.stacks) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-gold-400" /></div>;
  }

  const myStack = state.stacks[myId] ?? 0;
  const myAnte = state.antes[myId] ?? 0;
  const isSeated = state.playerIds.includes(myId);
  const mePlaying = state.players.find((p) => p.playerId === myId);
  const left = survivors(state);
  const gameOver = left.length === 0 || (state.playerIds.length > 1 && left.length <= 1);
  const dealerScore = state.dealerRevealed ? handName3(state.dealerHand) : null;
  const undecided = state.players.filter((p) => p.decision === null);

  const denoms = denomsForBuyIn(state.stake);
  const anteVal = Object.entries(anteTray).reduce((s, [d, c]) => s + Number(d) * c, 0);
  const addAnteChip = (d: number) => { if (anteVal + d <= myStack) setAnteTray((t) => ({ ...t, [d]: (t[d] ?? 0) + 1 })); };
  const removeAnteChip = (d: number) => setAnteTray((t) => ({ ...t, [d]: Math.max(0, (t[d] ?? 0) - 1) }));
  const placeAnte = async () => {
    if (anteVal <= 0) { toast({ title: "Tap some chips to ante", variant: "destructive" }); return; }
    setAnteTray({});
    await updateState(setAnte(state, myId, anteVal));
  };
  const clearAnte = async () => { setAnteTray({}); await updateState(setAnte(state, myId, 0)); };

  const deal = async () => {
    if (!anyAnte(state)) { toast({ title: "No antes placed yet", variant: "destructive" }); return; }
    resolveRef.current = false;
    await updateState(dealThreeCard(state));
  };
  const doDecide = async (decision: "play" | "fold") => {
    if (!mePlaying || mePlaying.decision !== null || busy) return;
    setBusy(true);
    await updateState(decide(state, myId, decision));
    setBusy(false);
  };
  const startNext = async () => { resolveRef.current = false; await updateState(nextRound(state)); };
  const finish = async () => { setSaving(true); await supabase.rpc("finish_table_game", { p_game_id: game.id }); setSaving(false); onGameEnd(); };

  const seatProfiles = state.playerIds.map((id) => players.find((p) => p.id === id)).filter(Boolean) as Profile[];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="bj-table px-3 sm:px-6 pt-6 pb-16 sm:pb-20 mt-3">
        {/* Dealer */}
        <div className="flex flex-col items-center mb-5">
          <span className="font-display text-xs font-bold uppercase tracking-[0.3em] text-gold-400/90 mb-2">🎩 Dealer{dealerScore ? ` — ${dealerScore}` : ""}</span>
          <div className="flex justify-center min-h-[6rem] items-center">
            {state.dealerHand.length === 0 ? (
              <span className="text-white/40 text-sm">— waiting for the deal —</span>
            ) : (
              state.dealerHand.map((card, i) => (
                <div key={i} className={i > 0 ? "-ml-7" : ""}>
                  {state.dealerRevealed ? <PlayingCard rank={card.display} suit={card.suit} size="sm" /> : <PlayingCard rank="?" suit="?" faceDown size="sm" />}
                </div>
              ))
            )}
          </div>
          {state.dealerQualified !== null && (
            <span className={`mt-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${state.dealerQualified ? "text-white/80 bg-white/10" : "text-yellow-400 bg-yellow-400/15"}`}>
              {state.dealerQualified ? "Dealer qualifies" : "Dealer doesn't qualify (Q-high+)"}
            </span>
          )}
        </div>

        {/* Center branding */}
        <div className="flex flex-col items-center text-center mb-5 select-none">
          <div className="w-9 h-9 rotate-45 bg-black/30 border border-gold-500/50 flex items-center justify-center mb-2"><Spade className="w-4 h-4 text-gold-400 -rotate-45" /></div>
          <p className="font-display text-lg sm:text-xl font-black uppercase gold-gradient leading-none">Gabe&apos;s Chips</p>
          <p className="font-serif text-[11px] sm:text-xs tracking-[0.3em] uppercase text-gold-400/70 mt-1">3 Card Poker</p>
          <p className="text-[10px] tracking-[0.2em] uppercase text-white/40 mt-1">Round {state.round} · Buy-in {formatChips(state.stake)}</p>
        </div>

        {/* Seats */}
        <div className="flex justify-center items-start gap-2 sm:gap-3 flex-wrap">
          {seatProfiles.map((profile, i) => {
            const p = state.players.find((x) => x.playerId === profile.id);
            const isMe = profile.id === myId;
            const stack = state.stacks[profile.id] ?? 0;
            const ante = state.antes[profile.id] ?? 0;
            const outcome = state.results?.[profile.id] ?? null;
            const showCards = (isMe || state.phase === "reveal" || state.phase === "result") && !!p;
            return (
              <div key={profile.id} style={{ transform: `translateY(${arcDrop(i, seatProfiles.length)}px)` }}
                className={`flex flex-col items-center gap-1 p-2 rounded-xl ${isMe ? "bg-black/35 ring-1 ring-gold-500/60" : "bg-black/20"} ${stack <= 0 && !p ? "opacity-50" : ""}`}>
                <div className="flex justify-center min-h-[5rem] items-center">
                  {p ? (
                    p.hand.map((card, j) => (
                      <div key={j} className={j > 0 ? "-ml-7" : ""}>
                        {showCards ? <PlayingCard rank={card.display} suit={card.suit} size="sm" /> : <PlayingCard rank="?" suit="?" faceDown size="sm" />}
                      </div>
                    ))
                  ) : ante > 0 ? <span className="text-gold-400 font-mono text-sm">ante {formatChips(ante)}</span> : <span className="text-white/30 text-xs">{stack > 0 ? "—" : "out"}</span>}
                </div>
                <div className="flex items-center gap-1.5 h-5">
                  {outcome ? <span className={`text-[10px] font-bold border px-1.5 py-0.5 rounded-full ${OUTCOME_CLASS[outcome]}`}>{OUTCOME_LABEL[outcome]}</span>
                    : p?.decision === "fold" ? <span className="text-[10px] font-bold text-red-400 bg-red-400/15 px-1.5 py-0.5 rounded-full">FOLD</span>
                    : p?.decision === "play" ? <span className="text-[10px] font-bold text-green-400 bg-green-400/15 px-1.5 py-0.5 rounded-full">PLAY</span>
                    : p ? <span className="text-[10px] text-white/40">deciding…</span> : null}
                </div>
                <PlayerAvatar username={profile.username} userId={profile.id} size="sm" isHost={profile.id === lobby.host_id} />
                <span className={`text-[11px] leading-none truncate max-w-[90px] ${isMe ? "text-gold-400 font-semibold" : "text-white/70"}`}>{isMe ? "You" : profile.username}</span>
                <span className="text-[11px] font-mono text-gold-300/90">{formatChips(stack)}</span>
                {outcome && <span className="text-[10px] text-white/50 leading-none">{outcome === "lose" ? `−${formatChips(ante)}` : `+${formatChips(threeCardPayout(outcome, ante) - ante)}`}</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Game over */}
      {gameOver && state.phase !== "deciding" && state.phase !== "reveal" ? (
        <div className="casino-card p-6 text-center border-gold-500/40">
          <Trophy className="w-10 h-10 text-gold-400 mx-auto mb-3" />
          <h2 className="font-display text-3xl font-black gold-gradient mb-2 uppercase">
            {left.length === 1 ? (left[0] === myId ? "You're the last standing!" : `${nameOf(left[0])} is the last standing!`) : "Table's busted"}
          </h2>
          <p className="text-muted-foreground mb-4">{left.length === 1 ? "Everyone else lost their chips to the house." : "The house took it all."}</p>
          {amBoss ? <Button variant="gold" size="lg" onClick={finish} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Cash Out &amp; Finish</Button>
            : <p className="text-sm text-muted-foreground">Waiting for the host to cash out…</p>}
        </div>
      ) : (
        <>
          {/* Betting — choose ante */}
          {state.phase === "betting" && isSeated && (
            <div className="casino-card p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-semibold shrink-0">Your ante</span>
                <ChipStack amount={myStack} denoms={denoms} size={18} />
                <span className="font-mono text-gold-400 ml-auto shrink-0">{formatChips(myStack)}</span>
              </div>
              {myAnte > 0 ? (
                <div className="flex items-center justify-between rounded-lg bg-gold-500/10 border border-gold-500/30 px-3 py-2">
                  <span className="text-gold-300 font-semibold">Ante: {formatChips(myAnte)}</span>
                  <Button variant="ghost" size="sm" onClick={clearAnte}>Clear</Button>
                </div>
              ) : myStack <= 0 ? (
                <p className="text-sm text-red-400/90 text-center py-1">You&apos;re out of chips — eliminated.</p>
              ) : (
                <>
                  <p className="text-[11px] text-muted-foreground">Tap chips to set your ante</p>
                  <div className="flex flex-wrap gap-2">
                    {denoms.map((d) => (
                      <button key={d} type="button" disabled={anteVal + d > myStack} onClick={() => addAnteChip(d)}
                        className={`rounded-full ${anteVal + d > myStack ? "opacity-30" : "hover:scale-105 active:scale-95 transition-transform"}`}>
                        <Chip value={d} size={40} />
                      </button>
                    ))}
                  </div>
                  {anteVal > 0 && (
                    <div className="rounded-xl bg-black/30 border border-gold-500/20 p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] text-muted-foreground">Ante — tap to remove</span>
                        <span className="font-mono font-semibold text-gold-400">{formatChips(anteVal)}</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(anteTray).filter(([, c]) => c > 0).map(([d, c]) => (
                          <button key={d} type="button" onClick={() => removeAnteChip(Number(d))} className="flex items-center gap-1">
                            <Chip value={Number(d)} size={30} /><span className="text-[10px] text-muted-foreground">×{c}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <Button variant="gold" className="w-full" onClick={placeAnte} disabled={anteVal <= 0}>
                    <Coins className="w-4 h-4 mr-1.5" /> Ante {formatChips(anteVal)}
                  </Button>
                </>
              )}
            </div>
          )}

          {/* Betting — host deals */}
          {state.phase === "betting" && amBoss && (
            <div className="casino-card p-4 space-y-3">
              <p className="text-sm font-medium text-gold-400">🎩 You run the table</p>
              <div className="space-y-1.5">
                {seatProfiles.map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-sm">
                    <span className="text-white/90">{p.id === myId ? "You" : p.username} <span className="text-white/40">· {formatChips(state.stacks[p.id] ?? 0)}</span></span>
                    <span className={(state.antes[p.id] ?? 0) > 0 ? "text-gold-400 font-mono" : "text-white/40"}>{(state.antes[p.id] ?? 0) > 0 ? formatChips(state.antes[p.id]) : (state.stacks[p.id] ?? 0) > 0 ? "waiting…" : "out"}</span>
                  </div>
                ))}
              </div>
              <Button variant="gold" size="lg" className="w-full" onClick={deal} disabled={!anyAnte(state)}>Deal Round</Button>
              <Button variant="outline" size="sm" className="w-full border-destructive/40 text-destructive hover:bg-destructive/10" onClick={finish} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <DoorClosed className="w-4 h-4 mr-2" />} End Game &amp; Cash Out
              </Button>
            </div>
          )}

          {/* Deciding — my play/fold */}
          {state.phase === "deciding" && mePlaying && (
            mePlaying.decision === null ? (
              <div className="casino-card p-4 space-y-3 text-center">
                <p className="text-sm font-medium">Your hand: <strong className="text-gold-400 uppercase">{handName3(mePlaying.hand)}</strong> · ante {formatChips(myAnte)}</p>
                <div className="grid grid-cols-2 gap-3">
                  <Button variant="gold" size="lg" disabled={busy} onClick={() => doDecide("play")}><Check className="w-4 h-4 mr-2" /> Play</Button>
                  <Button variant="outline" size="lg" className="border-destructive/40 text-destructive hover:bg-destructive/10" disabled={busy} onClick={() => doDecide("fold")}><X className="w-4 h-4 mr-2" /> Fold</Button>
                </div>
              </div>
            ) : (
              <div className="casino-card p-4 text-center text-sm text-muted-foreground">
                <div className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> You {mePlaying.decision === "play" ? "played" : "folded"} — waiting for {undecided.length} more…</div>
              </div>
            )
          )}
          {state.phase === "deciding" && !mePlaying && (
            <div className="casino-card p-4 text-center text-sm text-muted-foreground"><div className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Players are deciding…</div></div>
          )}
          {state.phase === "reveal" && (
            <div className="casino-card p-4 text-center"><Loader2 className="w-5 h-5 animate-spin text-gold-400 mx-auto mb-1" /><p className="text-sm text-muted-foreground">Dealer reveals…</p></div>
          )}

          {/* Result */}
          {state.phase === "result" && (
            <div className="casino-card p-4 space-y-3 text-center">
              {isSeated && state.results?.[myId] && (
                <p className="font-display text-2xl font-black gold-gradient uppercase">
                  {state.results[myId] === "blackjack" ? "Bonus win!" : state.results[myId] === "win" ? "You beat the dealer!" : state.results[myId] === "push" ? "Push" : "You lose"}
                </p>
              )}
              <p className="text-sm text-muted-foreground">Your stack: <span className="font-mono text-gold-400">{formatChips(myStack)}</span></p>
              {amBoss ? (
                <div className="space-y-2">
                  <Button variant="gold" size="lg" className="w-full" onClick={startNext}>Next Round</Button>
                  <Button variant="outline" size="sm" className="w-full border-destructive/40 text-destructive hover:bg-destructive/10" onClick={finish} disabled={saving}>
                    {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <DoorClosed className="w-4 h-4 mr-2" />} End Game &amp; Cash Out
                  </Button>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Waiting for the host…</div>
              )}
            </div>
          )}
        </>
      )}

      <Toaster />
    </div>
  );
}
