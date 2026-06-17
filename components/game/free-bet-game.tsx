"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { PlayerAvatar } from "@/components/player-avatar";
import { PlayingCard } from "./playing-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, Plus, Hand, Zap, Coins, DoorClosed, SplitSquareHorizontal } from "lucide-react";
import { formatChips } from "@/lib/utils";
import {
  type FreeBetState,
  type FBPlayerHand,
  type FBOutcome,
  initFreeBetTable,
  setBet,
  anyBet,
  dealHand,
  hitPlayer,
  standPlayer,
  freeDouble,
  canFreeDouble,
  splitHand,
  canSplit,
  splitIsFree,
  activeHandIndex,
  allPlayersDone,
  revealDealer,
  resolveDealer,
  nextHand,
  handValue,
  isBlackjack,
  tableBroke,
} from "@/lib/game-logic/free-bet-blackjack";
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

const OUTCOME_LABEL: Record<FBOutcome, string> = { win: "WIN", lose: "LOSE", push: "PUSH", blackjack: "BJ 3:2" };
const OUTCOME_CLASS: Record<FBOutcome, string> = {
  win: "text-green-400 bg-green-500/15 border-green-500/40",
  lose: "text-red-400 bg-red-500/15 border-red-500/40",
  push: "text-yellow-400 bg-yellow-500/15 border-yellow-500/40",
  blackjack: "text-gold-400 bg-gold-500/15 border-gold-500/60",
};

function arcDrop(index: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round(Math.sin((index / (count - 1)) * Math.PI) * 18);
}

function HandView({ ph, active, size }: { ph: FBPlayerHand; active: boolean; size: "sm" | "md" }) {
  const value = handValue(ph.hand);
  const bj = !ph.fromSplit && isBlackjack(ph.hand);
  return (
    <div className={`flex flex-col items-center gap-1 rounded-lg p-1 ${active ? "ring-2 ring-gold-400 bg-gold-500/10" : ""}`}>
      <div className="flex justify-center">
        {ph.hand.map((card, j) => (
          <div key={j} className={j > 0 ? (size === "sm" ? "-ml-7" : "-ml-8") : ""}>
            <PlayingCard rank={card.display} suit={card.suit} size={size} highlight={value === 21} />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1 flex-wrap justify-center">
        <span className={`text-base font-bold leading-none ${value > 21 ? "text-red-400" : value === 21 ? "text-gold-400" : "text-white"}`}>{value}</span>
        {ph.freeBet > 0 && <span className="text-[9px] font-bold text-green-300 bg-green-400/15 px-1 rounded-full">FREE {ph.doubled ? "2×" : ""}</span>}
        {ph.outcome ? (
          <span className={`text-[9px] font-bold border px-1 py-0.5 rounded-full ${OUTCOME_CLASS[ph.outcome]}`}>{OUTCOME_LABEL[ph.outcome]}</span>
        ) : (
          <>
            {bj && <span className="text-[9px] font-bold text-gold-400 bg-gold-400/15 px-1 rounded-full">BJ!</span>}
            {ph.busted && <span className="text-[9px] font-bold text-red-400 bg-red-400/15 px-1 rounded-full">BUST</span>}
            {ph.standing && !ph.busted && !bj && ph.freeBet === 0 && <span className="text-[9px] font-bold text-blue-400 bg-blue-400/15 px-1 rounded-full">STAND</span>}
          </>
        )}
      </div>
    </div>
  );
}

export function FreeBetGame({ game, lobby, players, currentUser, onGameEnd }: Props) {
  const [state, setState] = useState<FreeBetState | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [betInput, setBetInput] = useState("");
  const [rebuyInputs, setRebuyInputs] = useState<Record<string, string>>({});
  const dealerStarted = useRef(false);

  const supabase = createClient();
  const { toast } = useToast();
  const myId = currentUser.id;
  const dealerId = lobby.dealer_id;
  const boss = dealerId ?? lobby.host_id;
  const amBoss = myId === boss;
  const amApprover = myId === boss || myId === lobby.host_id;
  const isDealerMe = !!dealerId && dealerId === myId;
  const dealerProfile = dealerId ? players.find((p) => p.id === dealerId) : undefined;
  const nameOf = (id: string) => players.find((p) => p.id === id)?.username ?? "Player";

  const updateState = async (newState: FreeBetState) => {
    setState(newState);
    await supabase.from("games").update({ state: newState as unknown as Record<string, unknown> }).eq("id", game.id);
  };
  const reloadState = useCallback(async () => {
    const { data } = await supabase.from("games").select("state").eq("id", game.id).single();
    if (data?.state) setState(data.state as unknown as FreeBetState);
  }, [supabase, game.id]);

  const runDealerSequence = useCallback(async (s: FreeBetState) => {
    if (dealerStarted.current) return;
    dealerStarted.current = true;
    const revealed = revealDealer(s);
    await updateState(revealed);
    setTimeout(async () => { await updateState(resolveDealer(revealed)); }, 1800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id, supabase]);

  const loadState = useCallback(async () => {
    const { data } = await supabase.from("games").select("state").eq("id", game.id).single();
    const existing = data?.state as Record<string, unknown> | null;
    const isTable = !!existing?.phase && !!existing?.stacks;
    if (!isTable) {
      if (amBoss) {
        const seated = players.filter((p) => p.id !== dealerId);
        const orderedIds = [
          ...(seated.some((p) => p.id === lobby.host_id) ? [lobby.host_id] : []),
          ...seated.filter((p) => p.id !== lobby.host_id).map((p) => p.id),
        ];
        const buyIn = (existing?.stake as number) ?? 0;
        const initial = initFreeBetTable(orderedIds, buyIn, dealerId);
        await supabase.from("games").update({ state: initial as unknown as Record<string, unknown> }).eq("id", game.id);
        setState(initial);
      }
    } else {
      setState(existing as unknown as FreeBetState);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id, players, amBoss, lobby.host_id, dealerId, supabase]);

  useEffect(() => { loadState(); }, [loadState]);

  useEffect(() => {
    const channel = supabase
      .channel(`game-fb-${game.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${game.id}` },
        (payload) => {
          const next = payload.new.state as unknown as FreeBetState;
          if (next?.stacks) setState(next);
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [game.id, supabase]);

  useEffect(() => {
    if (!state || !amBoss) return;
    if (state.phase === "playing" && state.hands.length > 0 && allPlayersDone(state) && !dealerStarted.current) {
      runDealerSequence(state);
    }
  }, [state, amBoss, runDealerSequence]);

  if (!state || !state.stacks) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-gold-400" /></div>;
  }

  const myStack = state.stacks[myId] ?? 0;
  const myBet = state.bets[myId] ?? 0;
  const amSeated = myId !== dealerId && state.playerIds.includes(myId);
  const myHands = state.hands.filter((h) => h.playerId === myId);
  const myActiveIdx = activeHandIndex(state, myId);
  const myActive = myActiveIdx >= 0 ? state.hands[myActiveIdx] : null;
  const myDone = amSeated && myHands.length > 0 && myActiveIdx < 0;
  const stillPlaying = state.hands.filter((h) => !h.standing && !h.busted);

  const dealerRevealed = state.dealerRevealed;
  const dealerValue = handValue(state.dealerHand);
  const dealerUpValue = state.dealerHand.length ? handValue([state.dealerHand[0]]) : 0;
  const dealerBJ = state.dealerHand.length === 2 && isBlackjack(state.dealerHand);
  const dealer22 = dealerRevealed && dealerValue === 22;
  const dealerBusted = dealerValue > 22;
  const broke = tableBroke(state);

  const fdbl = state.phase === "playing" && canFreeDouble(state, myId);
  const spl = state.phase === "playing" && canSplit(state, myId);
  const splFree = spl && splitIsFree(state, myId);

  const placeBet = async () => {
    const amt = Math.floor(Number(betInput));
    if (!Number.isFinite(amt) || amt <= 0) { toast({ title: "Enter a bet", variant: "destructive" }); return; }
    setBetInput("");
    await updateState(setBet(state, myId, amt));
  };
  const clearMyBet = async () => updateState(setBet(state, myId, 0));

  const deal = async () => {
    if (!anyBet(state)) { toast({ title: "No bets placed yet", variant: "destructive" }); return; }
    const dealt = dealHand(state);
    dealerStarted.current = false;
    await updateState(dealt);
    if (allPlayersDone(dealt)) runDealerSequence(dealt);
  };

  const doMove = async (fn: (s: FreeBetState, pid: string) => FreeBetState) => {
    if (actionLoading || state.phase !== "playing" || myActiveIdx < 0) return;
    setActionLoading(true);
    await updateState(fn(state, myId));
    setActionLoading(false);
  };

  const startNextHand = async () => { dealerStarted.current = false; await updateState(nextHand(state)); };
  const endGame = async () => { setSaving(true); await supabase.rpc("finish_table_game", { p_game_id: game.id }); setSaving(false); onGameEnd(); };

  const requestRebuy = async () => {
    if (state.rebuyReq.includes(myId)) return;
    await updateState({ ...state, rebuyReq: [...state.rebuyReq, myId] });
    toast({ title: "Rebuy requested", description: "Waiting for the dealer to approve." });
  };
  const approveRebuy = async (pid: string) => {
    const amt = Math.floor(Number(rebuyInputs[pid] ?? state.stake));
    if (!Number.isFinite(amt) || amt <= 0) { toast({ title: "Enter an amount", variant: "destructive" }); return; }
    const { error } = await supabase.rpc("table_rebuy", { p_game_id: game.id, p_player_id: pid, p_amount: amt });
    if (error) { toast({ title: "Rebuy failed", description: error.message, variant: "destructive" }); return; }
    setRebuyInputs((r) => ({ ...r, [pid]: "" }));
    await reloadState();
    toast({ title: "Rebuy approved", description: `${nameOf(pid)} +${formatChips(amt)}` });
  };

  const seatProfiles = state.playerIds.map((id) => players.find((p) => p.id === id)).filter(Boolean) as Profile[];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="bj-table px-3 sm:px-6 pt-6 pb-16 sm:pb-20 mt-3">
        {/* Dealer */}
        <div className="flex flex-col items-center mb-5">
          <span className="font-display text-xs font-bold uppercase tracking-[0.3em] text-gold-400/90 mb-2">
            {dealerProfile ? `👑 ${dealerProfile.username}${isDealerMe ? " (You)" : ""}` : "🎩 House Dealer"}
          </span>
          <div className="flex justify-center min-h-[7rem] items-center">
            {state.dealerHand.length === 0 ? (
              <span className="text-white/40 text-sm">— waiting for the deal —</span>
            ) : (
              state.dealerHand.map((card, i) =>
                i === 1 && !dealerRevealed ? (
                  <div key={i} className="-ml-8"><PlayingCard rank="?" suit="?" faceDown size="md" /></div>
                ) : (
                  <div key={i} className={i > 0 ? "-ml-8" : ""}>
                    <PlayingCard rank={card.display} suit={card.suit} size="md" highlight={dealerRevealed && dealerValue === 21} />
                  </div>
                )
              )
            )}
          </div>
          {state.dealerHand.length > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <span className={`text-xl font-bold leading-none ${dealerRevealed && dealerBusted ? "text-red-400" : dealer22 ? "text-yellow-400" : "text-white"}`}>
                {dealerRevealed ? dealerValue : `${dealerUpValue} + ?`}
              </span>
              {state.phase === "dealer" && <span className="text-[10px] font-bold text-gold-400 bg-black/40 px-2 py-0.5 rounded-full animate-pulse">DRAWING…</span>}
              {dealerRevealed && state.phase === "result" && dealerBJ && <span className="text-[10px] font-bold text-gold-400 bg-gold-400/15 border border-gold-500/60 px-2 py-0.5 rounded-full">BLACKJACK</span>}
              {dealer22 && <span className="text-[10px] font-bold text-yellow-400 bg-yellow-400/15 border border-yellow-500/40 px-2 py-0.5 rounded-full">PUSH 22</span>}
              {dealerRevealed && dealerBusted && <span className="text-[10px] font-bold text-red-400 bg-red-400/15 border border-red-500/40 px-2 py-0.5 rounded-full">BUST</span>}
            </div>
          )}
          {dealerProfile && <span className="mt-1 text-[11px] font-mono text-gold-300/90">Bank {formatChips(state.stacks[dealerProfile.id] ?? 0)}</span>}
        </div>

        {/* Center branding — matches the main menu */}
        <div className="flex flex-col items-center text-center mb-6 select-none">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Gabe's Chips" className="w-14 h-14 object-contain mb-1" />
          <p className="font-display text-xl sm:text-2xl font-black uppercase logo-gold leading-none">Gabe&apos;s Chips</p>
          <p className="font-serif text-[11px] sm:text-xs tracking-[0.3em] uppercase text-gold-400/70 mt-2">Free Bet · Free double 9·10·11 · Free splits</p>
          <p className="text-[10px] tracking-[0.2em] uppercase text-white/40 mt-1">Hand {state.round} · Buy-in {formatChips(state.stake)} · Dealer 22 pushes</p>
        </div>

        {/* Seats */}
        <div className="flex justify-center items-start gap-2 sm:gap-3 flex-wrap">
          {seatProfiles.map((profile, i) => {
            const phs = state.hands.filter((h) => h.playerId === profile.id);
            const isMe = profile.id === myId;
            const stack = state.stacks[profile.id] ?? 0;
            const bet = state.bets[profile.id] ?? 0;
            const cardSize: "sm" | "md" = phs.length > 1 ? "sm" : "md";
            return (
              <div key={profile.id} style={{ transform: `translateY(${arcDrop(i, seatProfiles.length)}px)` }}
                className={`flex flex-col items-center gap-1.5 p-2 rounded-xl ${isMe ? "bg-black/35 ring-1 ring-gold-500/60" : "bg-black/20"} ${stack <= 0 && bet <= 0 && phs.length === 0 ? "opacity-50" : ""}`}>
                {phs.length > 0 ? (
                  <div className="flex items-start justify-center gap-1">
                    {phs.map((ph) => (
                      <HandView key={state.hands.indexOf(ph)} ph={ph} size={cardSize}
                        active={state.phase === "playing" && state.hands.indexOf(ph) === activeHandIndex(state, profile.id)} />
                    ))}
                  </div>
                ) : (
                  <div className="h-[7rem] flex items-center justify-center">
                    {bet > 0 ? <span className="text-gold-400 font-mono text-sm">bet {formatChips(bet)}</span> : <span className="text-white/30 text-xs">{stack > 0 ? "no bet" : "out"}</span>}
                  </div>
                )}
                <PlayerAvatar username={profile.username} userId={profile.id} size="sm" isHost={profile.id === lobby.host_id} />
                <span className={`text-xs leading-none truncate max-w-[110px] ${isMe ? "text-gold-400 font-semibold" : "text-white/70"}`}>{isMe ? "You" : profile.username}</span>
                <span className="text-[11px] font-mono text-gold-300/90">{formatChips(stack)}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Betting — seated player */}
      {state.phase === "betting" && amSeated && (
        <div className="casino-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Your bet this hand</span>
            <span className="text-sm text-muted-foreground">Stack <span className="font-mono text-gold-400">{formatChips(myStack)}</span></span>
          </div>
          {myBet > 0 ? (
            <div className="flex items-center justify-between rounded-lg bg-gold-500/10 border border-gold-500/30 px-3 py-2">
              <span className="text-gold-300 font-semibold">Bet placed: {formatChips(myBet)}</span>
              <Button variant="ghost" size="sm" onClick={clearMyBet}>Clear</Button>
            </div>
          ) : myStack <= 0 ? (
            <p className="text-sm text-red-400/90 text-center py-1">You&apos;re out of chips — request a rebuy below.</p>
          ) : (
            <>
              <div className="flex gap-2">
                <Input type="number" inputMode="numeric" min={1} max={myStack} placeholder="Amount" value={betInput} onChange={(e) => setBetInput(e.target.value)} className="flex-1" />
                <Button variant="gold" onClick={placeBet} disabled={!betInput}><Coins className="w-4 h-4 mr-1.5" /> Bet</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {[state.stake, Math.round(state.stake / 2), Math.round(state.stake / 4)].filter((v, idx, a) => v > 0 && a.indexOf(v) === idx).map((v) => (
                  <Button key={v} variant="outline" size="sm" onClick={() => setBetInput(String(Math.min(v, myStack)))}>{formatChips(v)}</Button>
                ))}
                <Button variant="outline" size="sm" onClick={() => setBetInput(String(myStack))}>All in</Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Betting — boss deals */}
      {state.phase === "betting" && amBoss && (
        <div className="casino-card p-4 space-y-3">
          <p className="text-sm font-medium text-gold-400">{isDealerMe ? "👑 You're the dealer" : "🎩 You run the table"}</p>
          <div className="space-y-1.5">
            {seatProfiles.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-sm">
                <span className="text-white/90">{p.id === myId ? "You" : p.username} <span className="text-white/40">· {formatChips(state.stacks[p.id] ?? 0)}</span></span>
                <span className={(state.bets[p.id] ?? 0) > 0 ? "text-gold-400 font-mono" : "text-white/40"}>{(state.bets[p.id] ?? 0) > 0 ? formatChips(state.bets[p.id]) : (state.stacks[p.id] ?? 0) > 0 ? "waiting…" : "out"}</span>
              </div>
            ))}
          </div>
          {broke ? <p className="text-sm text-red-400/90 text-center">All players are out of chips.</p>
            : <Button variant="gold" size="lg" className="w-full" onClick={deal} disabled={!anyBet(state)}>Deal Hand</Button>}
          <Button variant="outline" size="sm" className="w-full border-destructive/40 text-destructive hover:bg-destructive/10" onClick={endGame} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <DoorClosed className="w-4 h-4 mr-2" />} End Game &amp; Cash Out
          </Button>
        </div>
      )}

      {/* Playing — my actions */}
      {state.phase === "playing" && myHands.length > 0 && (
        <div className="casino-card p-4">
          {myDone ? (
            <div className="text-center space-y-1">
              <p className="text-muted-foreground text-sm font-medium">You&apos;re all set — waiting for the table.</p>
              {stillPlaying.length > 0 && <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" /> {stillPlaying.length} hand{stillPlaying.length > 1 ? "s" : ""} still in play…</div>}
            </div>
          ) : myActive ? (
            <>
              {myHands.length > 1 && (
                <p className="text-center text-xs text-gold-400 mb-2">Playing hand {myHands.indexOf(myActive) + 1} of {myHands.length}{myActive.freeBet > 0 ? " · FREE" : ` · bet ${formatChips(myActive.bet)}`}</p>
              )}
              <div className={`grid ${fdbl && spl ? "grid-cols-2 sm:grid-cols-4" : fdbl || spl ? "grid-cols-3" : "grid-cols-2"} gap-2`}>
                <Button variant="gold" size="lg" onClick={() => doMove(hitPlayer)} disabled={actionLoading || handValue(myActive.hand) >= 21} className="h-14 flex-col gap-0.5"><Plus className="w-5 h-5" /><span className="text-xs">Hit</span></Button>
                <Button variant="casino" size="lg" onClick={() => doMove(standPlayer)} disabled={actionLoading} className="h-14 flex-col gap-0.5"><Hand className="w-5 h-5" /><span className="text-xs">Stand</span></Button>
                {fdbl && <Button variant="casino" size="lg" onClick={() => doMove(freeDouble)} disabled={actionLoading} className="h-14 flex-col gap-0.5 border-green-400/60"><Zap className="w-5 h-5 text-green-300" /><span className="text-xs">Free Double</span></Button>}
                {spl && <Button variant="casino" size="lg" onClick={() => doMove(splitHand)} disabled={actionLoading} className="h-14 flex-col gap-0.5 border-green-400/50"><SplitSquareHorizontal className="w-5 h-5" /><span className="text-xs">{splFree ? "Free Split" : "Split"}</span></Button>}
              </div>
            </>
          ) : null}
        </div>
      )}

      {/* Playing — dealer waiting view */}
      {state.phase === "playing" && isDealerMe && (
        <div className="casino-card p-4 text-center">
          <p className="text-sm font-medium text-gold-400">👑 You&apos;re the dealer</p>
          <p className="text-xs text-muted-foreground mt-1">Dealer 22 pushes all live hands. You bank the free bets. Your hand plays itself once everyone acts.</p>
          {stillPlaying.length > 0 && <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm mt-2"><Loader2 className="w-4 h-4 animate-spin" /> {stillPlaying.length} in play…</div>}
        </div>
      )}

      {state.phase === "dealer" && (
        <div className="casino-card p-4 text-center"><Loader2 className="w-5 h-5 animate-spin text-gold-400 mx-auto mb-1" /><p className="text-sm text-muted-foreground">Dealer reveals the hole card…</p></div>
      )}

      {/* Result */}
      {state.phase === "result" && (
        <div className="casino-card p-4 space-y-3 text-center">
          <p className="text-sm text-muted-foreground">Your stack: <span className="font-mono text-gold-400">{formatChips(myStack)}</span></p>
          {amBoss ? (
            <div className="space-y-2">
              {broke ? <p className="text-sm text-red-400/90">All players are out of chips — cash out to end.</p>
                : <Button variant="gold" size="lg" className="w-full" onClick={startNextHand}>Next Hand</Button>}
              <Button variant="outline" size="sm" className="w-full border-destructive/40 text-destructive hover:bg-destructive/10" onClick={endGame} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <DoorClosed className="w-4 h-4 mr-2" />} End Game &amp; Cash Out
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Waiting for the dealer…</div>
          )}
        </div>
      )}

      {/* Rebuy request */}
      {amSeated && myStack <= 0 && state.phase !== "playing" && state.phase !== "dealer" && (
        <div className="casino-card p-4 text-center">
          {state.rebuyReq.includes(myId) ? <p className="text-sm text-gold-400">Rebuy requested — waiting for the dealer to approve.</p>
            : <Button variant="gold" onClick={requestRebuy}><Coins className="w-4 h-4 mr-2" /> Request a rebuy</Button>}
        </div>
      )}

      {/* Rebuy approvals */}
      {amApprover && state.rebuyReq.length > 0 && (
        <div className="casino-card p-4 space-y-2">
          <p className="text-sm font-semibold">Rebuy requests</p>
          {state.rebuyReq.map((pid) => (
            <div key={pid} className="flex items-center gap-2">
              <span className="text-sm flex-1 truncate">{nameOf(pid)}</span>
              <Input type="number" inputMode="numeric" min={1} placeholder={String(state.stake)} value={rebuyInputs[pid] ?? ""} onChange={(e) => setRebuyInputs((r) => ({ ...r, [pid]: e.target.value }))} className="w-28" />
              <Button variant="gold" size="sm" onClick={() => approveRebuy(pid)}>Approve</Button>
            </div>
          ))}
        </div>
      )}

      <Toaster />
    </div>
  );
}
