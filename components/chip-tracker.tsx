"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Navbar } from "@/components/navbar";
import { PlayerAvatar } from "@/components/player-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/components/ui/use-toast";
import {
  Copy, Check, Loader2, Send, DoorOpen, History, ArrowRight, Dices, RotateCcw,
} from "lucide-react";
import { formatChips } from "@/lib/utils";
import type { Database } from "@/lib/supabase";

type Lobby = Database["public"]["Tables"]["lobbies"]["Row"];

interface Member {
  user_id: string;
  username: string;
  chips: number;                       // whole-chip total (non-denom rooms)
  chipCounts: Record<string, number>;  // per-denomination counts (denom rooms)
  betCents: number;                    // current blackjack bet
}
type HandPhase = "idle" | "betting" | "playing";
type Outcome = "win" | "lose" | "bj";
interface HandSnapshot {
  counts: Record<string, Record<string, number>>; // pre-payout player stacks
  dealerChips: number;                              // pre-payout dealer net (cents)
  bets: Record<string, number>;
  results: Record<string, Outcome>;
  marked: string[];
  logCount?: number; // # of hand-history rows inserted at payout (to undo)
}
interface TrackerState {
  phase: HandPhase;
  results: Record<string, Outcome>;
  marked: string[]; // order of marks, for Undo
  lastHand?: HandSnapshot | null; // for Undo after Pay Out
}
interface TransferRow {
  id: string;
  from_user: string;
  to_user: string;
  amount: number;
  note: string | null;
  created_at: string;
}

interface Props {
  lobby: Lobby;
  currentUserId: string;
}

// ----- chip visuals -----
function chipStyle(v: number) {
  if (v < 0.5) return { bg: "#e5e7eb", ring: "#94a3b8", text: "#111827" }; // white
  if (v < 1) return { bg: "#ec4899", ring: "#9d174d", text: "#ffffff" };    // pink
  if (v < 5) return { bg: "#2563eb", ring: "#1e3a8a", text: "#ffffff" };    // blue
  if (v < 25) return { bg: "#dc2626", ring: "#7f1d1d", text: "#ffffff" };   // red
  if (v < 100) return { bg: "#16a34a", ring: "#14532d", text: "#ffffff" };  // green
  return { bg: "#111827", ring: "#000000", text: "#fbbf24" };               // black
}
function chipLabel(v: number) {
  return v >= 1 ? `$${v % 1 === 0 ? v : v.toFixed(2)}` : `${Math.round(v * 100)}¢`;
}
function Chip({ value, size = 30 }: { value: number; size?: number }) {
  const s = chipStyle(value);
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className="shrink-0">
      <circle cx="20" cy="20" r="19" fill={s.bg} />
      <circle cx="20" cy="20" r="15.5" fill="none" stroke={s.ring} strokeWidth="5" strokeDasharray="5.2 6.95" />
      <circle cx="20" cy="20" r="11" fill={s.bg} stroke={s.ring} strokeWidth="1" />
      <text x="20" y="24" textAnchor="middle" fontSize="9" fontWeight="bold" fill={s.text}>{chipLabel(value)}</text>
    </svg>
  );
}
const sortedCounts = (counts: Record<string, number>) =>
  Object.entries(counts || {})
    .map(([v, c]) => [Number(v), c] as [number, number])
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[0] - a[0]);
const totalCents = (counts: Record<string, number>) =>
  sortedCounts(counts).reduce((s, [v, c]) => s + Math.round(v * 100) * c, 0);
const fmtCents = (cents: number) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

export function ChipTracker({ lobby, currentUserId }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [dealerId, setDealerId] = useState<string | null>(lobby.dealer_id);
  const [spinning, setSpinning] = useState(false);
  const [spinIdx, setSpinIdx] = useState(0);
  const [assignMode, setAssignMode] = useState(false);
  const [hand, setHand] = useState<TrackerState>(
    () => (lobby.tracker_state as unknown as TrackerState) ?? { phase: "idle", results: {}, marked: [] }
  );
  const [betTray, setBetTray] = useState<Record<string, number>>({}); // player composing a bet

  // denom-mode composer
  const [target, setTarget] = useState<string | null>(null);
  const [mode, setMode] = useState<"give" | "take">("give");
  const [tray, setTray] = useState<Record<string, number>>({});
  // simple-mode composer
  const [recipient, setRecipient] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);

  const router = useRouter();
  const supabase = createClient();
  const { toast } = useToast();
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>["channel"]> | null>(null);
  const spinTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const cfg = (lobby.tracker_config as { money?: boolean; game?: string; denominations?: { value: number; count: number }[] } | null) ?? {};
  const denominations = cfg.denominations ?? [];
  const denomMode = denominations.length > 0;
  const isBlackjack = (cfg.game ?? "").toLowerCase().includes("blackjack");
  const moneyMode = denomMode; // denom rooms track real money

  const startCounts = useCallback((): Record<string, number> => {
    const c: Record<string, number> = {};
    for (const d of denominations) c[String(d.value)] = (c[String(d.value)] ?? 0) + d.count;
    return c;
  }, [denominations]);

  const nameOf = (uid: string) => members.find((m) => m.user_id === uid)?.username ?? "Player";

  const loadMembers = useCallback(async () => {
    const { data } = await supabase.from("lobby_players").select("user_id, chips, chip_counts, bet_cents").eq("lobby_id", lobby.id);
    if (!data) return;
    const withProfiles = await Promise.all(
      data.map(async (lp) => {
        const { data: profile } = await supabase.from("profiles").select("username").eq("id", lp.user_id).single();
        return {
          user_id: lp.user_id,
          username: profile?.username ?? "Player",
          chips: lp.chips ?? 0,
          chipCounts: (lp.chip_counts as Record<string, number>) ?? {},
          betCents: lp.bet_cents ?? 0,
        };
      })
    );
    setMembers(withProfiles);
  }, [supabase, lobby.id]);

  const loadTransfers = useCallback(async () => {
    const { data } = await supabase
      .from("chip_transfers").select("*").eq("lobby_id", lobby.id)
      .order("created_at", { ascending: false }).limit(20);
    if (data) setTransfers(data as TransferRow[]);
  }, [supabase, lobby.id]);

  // Auto-join with a fresh stack — runs once on entry
  const joinedRef = useRef(false);
  useEffect(() => {
    if (joinedRef.current) return;
    joinedRef.current = true;
    (async () => {
      const { data: existing } = await supabase
        .from("lobby_players").select("user_id").eq("lobby_id", lobby.id).eq("user_id", currentUserId).maybeSingle();
      if (!existing) {
        await supabase.from("lobby_players").insert({
          lobby_id: lobby.id,
          user_id: currentUserId,
          chips: lobby.buy_in,
          chip_counts: denomMode ? startCounts() : null,
        });
      }
      await Promise.all([loadMembers(), loadTransfers()]);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Realtime
  useEffect(() => {
    const channel = supabase
      .channel(`tracker-${lobby.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "lobby_players", filter: `lobby_id=eq.${lobby.id}` }, () => loadMembers())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "lobbies", filter: `id=eq.${lobby.id}` },
        (payload) => {
          const l = payload.new as Lobby;
          setDealerId(l.dealer_id);
          setHand((l.tracker_state as unknown as TrackerState) ?? { phase: "idle", results: {}, marked: [] });
          loadMembers();
          loadTransfers();
        })
      .on("broadcast", { event: "transfer" }, ({ payload }) => {
        const p = payload as { from?: string; to?: string; cents?: number };
        loadMembers(); loadTransfers();
        if (p.to === currentUserId) {
          toast({ title: "💰 Chips received", description: `${p.from} → you: ${fmtCents(p.cents ?? 0)}` });
        }
      })
      .subscribe();
    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); channelRef.current = null; };
  }, [supabase, lobby.id, currentUserId, loadMembers, loadTransfers, toast]);

  const me = members.find((m) => m.user_id === currentUserId);
  const others = members.filter((m) => m.user_id !== currentUserId);
  const amDealer = denomMode && isBlackjack && dealerId === currentUserId;
  const hasDealer = denomMode && isBlackjack && !!dealerId && members.some((m) => m.user_id === dealerId);

  // Who the chips come from in the composer, and who they go to
  const sourceId = !isBlackjack ? currentUserId : mode === "give" ? currentUserId : target;
  const destId = !isBlackjack ? target : mode === "give" ? target : currentUserId;
  const sourceCounts = members.find((m) => m.user_id === sourceId)?.chipCounts ?? {};
  const trayCents = Object.entries(tray).reduce((s, [v, c]) => s + Math.round(Number(v) * 100) * c, 0);
  const availOf = (denom: string) => (sourceCounts[denom] ?? 0) - (tray[denom] ?? 0);

  const addToTray = (denom: string) => {
    if (availOf(denom) <= 0) return;
    setTray((t) => ({ ...t, [denom]: (t[denom] ?? 0) + 1 }));
  };
  const removeFromTray = (denom: string) => setTray((t) => ({ ...t, [denom]: Math.max(0, (t[denom] ?? 0) - 1) }));

  const sendTray = async () => {
    if (!sourceId || !destId || trayCents <= 0) {
      toast({ title: "Pick a player and select chips", variant: "destructive" });
      return;
    }
    const counts = Object.fromEntries(Object.entries(tray).filter(([, c]) => c > 0));
    setSending(true);
    const { error } = await supabase.rpc("transfer_chip_denoms", {
      p_lobby_id: lobby.id, p_from: sourceId, p_to: destId, p_counts: counts,
    });
    if (error) {
      toast({ title: "Transfer failed", description: error.message, variant: "destructive" });
      setSending(false);
      return;
    }
    channelRef.current?.send({ type: "broadcast", event: "transfer", payload: { from: nameOf(sourceId), to: destId, cents: trayCents } });
    setTray({});
    await Promise.all([loadMembers(), loadTransfers()]);
    toast({ title: "Chips moved", description: `${fmtCents(trayCents)} → ${nameOf(destId)}` });
    setSending(false);
  };

  // Simple (non-denom) send
  const handleSend = async () => {
    const amt = Number(amount);
    if (!recipient || !Number.isFinite(amt) || amt <= 0) {
      toast({ title: "Enter an amount and pick a recipient", variant: "destructive" });
      return;
    }
    setSending(true);
    const { error } = await supabase.rpc("transfer_chips", { p_lobby_id: lobby.id, p_to: recipient, p_amount: Math.floor(amt) });
    if (error) { toast({ title: "Transfer failed", description: error.message, variant: "destructive" }); setSending(false); return; }
    channelRef.current?.send({ type: "broadcast", event: "transfer", payload: { from: me?.username ?? "Someone", to: recipient, cents: Math.floor(amt) } });
    setAmount(""); setRecipient(null);
    await Promise.all([loadMembers(), loadTransfers()]);
    setSending(false);
  };

  const spinDealer = async () => {
    if (members.length < 2) { toast({ title: "Need 2+ players to pick a dealer", variant: "destructive" }); return; }
    const winner = members[Math.floor(Math.random() * members.length)];
    setSpinning(true);
    let ticks = 0;
    if (spinTimer.current) clearInterval(spinTimer.current);
    spinTimer.current = setInterval(async () => {
      ticks++;
      setSpinIdx(ticks % members.length);
      if (ticks >= 18) {
        if (spinTimer.current) clearInterval(spinTimer.current);
        setSpinning(false);
        await supabase.rpc("set_dealer", { p_lobby_id: lobby.id, p_dealer_id: winner.user_id });
        setDealerId(winner.user_id);
        await loadMembers();
        channelRef.current?.send({ type: "broadcast", event: "dealer", payload: { name: winner.username } });
      }
    }, 110);
  };

  // ===== Blackjack hand flow =====
  const denomVals = [...new Set(denominations.map((d) => d.value))].sort((a, b) => b - a);
  const minCents = denomVals.length ? Math.round(Math.min(...denomVals) * 100) : 1;
  const breakdown = (cents: number): Record<string, number> => {
    const counts: Record<string, number> = {};
    let rem = Math.max(0, Math.round(cents));
    for (const v of denomVals) {
      const vc = Math.round(v * 100);
      if (vc <= 0) continue;
      const n = Math.floor(rem / vc);
      if (n > 0) { counts[String(v)] = n; rem -= n * vc; }
    }
    return counts;
  };
  const writeHand = async (next: TrackerState) => {
    setHand(next);
    await supabase.from("lobbies").update({ tracker_state: next as unknown as Record<string, unknown> }).eq("id", lobby.id);
  };

  const assignDealer = async (pid: string) => {
    await supabase.rpc("set_dealer", { p_lobby_id: lobby.id, p_dealer_id: pid });
    setDealerId(pid); setAssignMode(false);
    await loadMembers();
    channelRef.current?.send({ type: "broadcast", event: "dealer", payload: { name: nameOf(pid) } });
  };

  const newHand = async () => {
    await supabase.rpc("bj_commit", { p_lobby_id: lobby.id, p_counts: {}, p_clear_bets: true });
    await writeHand({ phase: "betting", results: {}, marked: [], lastHand: null });
    setBetTray({});
    await loadMembers();
  };

  // Player composes a bet from their own chips, then commits
  const betCents = Object.entries(betTray).reduce((s, [v, c]) => s + Math.round(Number(v) * 100) * c, 0);
  const myCounts = me?.chipCounts ?? {};
  const betAvail = (denom: string) => (myCounts[denom] ?? 0) - (betTray[denom] ?? 0);
  const commitBet = async () => {
    await supabase.rpc("place_bet", { p_lobby_id: lobby.id, p_cents: betCents });
    setBetTray({});
    await loadMembers();
    toast({ title: "Bet placed", description: fmtCents(betCents) });
  };
  const clearBet = async () => {
    await supabase.rpc("place_bet", { p_lobby_id: lobby.id, p_cents: 0 });
    setBetTray({});
    await loadMembers();
  };

  const startHand = async () => {
    const updates: Record<string, Record<string, number>> = {};
    for (const m of members) {
      if (m.user_id === dealerId) continue;
      if (m.betCents > 0) updates[m.user_id] = breakdown(totalCents(m.chipCounts) - m.betCents);
    }
    await supabase.rpc("bj_commit", { p_lobby_id: lobby.id, p_counts: updates, p_clear_bets: false });
    await writeHand({ phase: "playing", results: {}, marked: [] });
    await loadMembers();
  };

  const markResult = async (pid: string, outcome: Outcome) => {
    const results = { ...hand.results, [pid]: outcome };
    const marked = [...hand.marked.filter((x) => x !== pid), pid];
    await writeHand({ ...hand, results, marked });
  };
  const dealerBlackjack = async () => {
    const results: Record<string, Outcome> = {};
    const marked: string[] = [];
    for (const m of others) if (m.betCents > 0) { results[m.user_id] = "lose"; marked.push(m.user_id); }
    await writeHand({ ...hand, results, marked });
    toast({ title: "Dealer Blackjack", description: "Everyone loses their bet." });
  };
  const undoMark = async () => {
    if (hand.marked.length === 0) return;
    const marked = [...hand.marked];
    const last = marked.pop()!;
    const results = { ...hand.results }; delete results[last];
    await writeHand({ ...hand, results, marked });
  };

  const dealerMember = members.find((m) => m.user_id === dealerId);
  const dealerNet = dealerMember?.chips ?? 0; // dealer bank (cents, signed)

  const payOut = async () => {
    // Snapshot the current (pre-payout) state so the dealer can Undo afterward
    const snapshot: HandSnapshot = {
      counts: Object.fromEntries(others.map((m) => [m.user_id, m.chipCounts])),
      dealerChips: dealerNet,
      bets: Object.fromEntries(others.map((m) => [m.user_id, m.betCents])),
      results: hand.results,
      marked: hand.marked,
    };

    const updates: Record<string, Record<string, number>> = {};
    const log: { from_user: string; to_user: string; amount: number; note: string }[] = [];
    let dealerDelta = 0;
    for (const m of others) {
      if (m.betCents <= 0) continue;
      const bet = m.betCents;
      const res = hand.results[m.user_id];
      let pTotal = totalCents(m.chipCounts); // already minus the escrowed bet
      if (res === "lose") {
        dealerDelta += bet;
        log.push({ from_user: m.user_id, to_user: dealerId!, amount: bet, note: "lost" });
      } else if (res === "win") {
        pTotal += 2 * bet; dealerDelta -= bet;
        log.push({ from_user: dealerId!, to_user: m.user_id, amount: bet, note: "won" });
      } else if (res === "bj") {
        const win = Math.floor((bet * 1.5) / minCents) * minCents;
        pTotal += bet + win; dealerDelta -= win;
        log.push({ from_user: dealerId!, to_user: m.user_id, amount: win, note: "blackjack" });
      } else {
        pTotal += bet; // unmarked → refund, no movement to log
      }
      updates[m.user_id] = breakdown(pTotal);
    }
    await supabase.rpc("bj_commit", {
      p_lobby_id: lobby.id, p_counts: updates, p_clear_bets: true, p_dealer_chips: dealerNet + dealerDelta,
      p_log: log,
    });
    snapshot.logCount = log.length;
    await writeHand({ phase: "idle", results: {}, marked: [], lastHand: snapshot });
    await Promise.all([loadMembers(), loadTransfers()]);
    toast({ title: "Hand paid out", description: "Tap Undo Last Hand if anything was wrong." });
  };

  const undoLastHand = async () => {
    const snap = hand.lastHand;
    if (!snap) return;
    await supabase.rpc("bj_commit", {
      p_lobby_id: lobby.id, p_counts: snap.counts, p_clear_bets: false,
      p_dealer_chips: snap.dealerChips, p_bets: snap.bets,
    });
    if (snap.logCount && snap.logCount > 0) {
      await supabase.rpc("bj_delete_recent_log", { p_lobby_id: lobby.id, p_count: snap.logCount });
    }
    await writeHand({ phase: "playing", results: snap.results, marked: snap.marked, lastHand: null });
    await Promise.all([loadMembers(), loadTransfers()]);
    toast({ title: "Payout undone", description: "Fix the results and pay out again." });
  };

  const potCents = others.reduce((s, m) => s + (m.betCents > 0 ? m.betCents : 0), 0);
  const allMarked = others.filter((m) => m.betCents > 0).every((m) => hand.results[m.user_id]);
  const anyBet = others.some((m) => m.betCents > 0);

  const handleCopy = () => { navigator.clipboard.writeText(lobby.code); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const handleLeave = () => router.push("/");

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-gold-400" /></div>;
  }

  // ===== Header (shared) =====
  const Header = (
    <div className="casino-card p-5">
      <div className="deco-chevrons mb-4" />
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-gold-400/80 mb-1">Chip Tracker</p>
          <h1 className="font-serif text-2xl font-bold">{lobby.name}</h1>
        </div>
        <div className="flex flex-row sm:flex-col items-center sm:items-end gap-2 shrink-0">
          <button onClick={handleCopy} className="lobby-code flex items-center gap-2 hover:border-gold-500/60 transition-colors" title="Copy code">
            {lobby.code}
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 opacity-50" />}
          </button>
          <span className="text-xs text-muted-foreground">Share to invite</span>
        </div>
      </div>
    </div>
  );

  // ===== Non-denomination rooms: simple list (whole chips) =====
  if (!denomMode) {
    const fmt = (u: number) => `${u < 0 ? "−" : ""}${formatChips(Math.abs(u))}`;
    return (
      <>
        <Navbar />
        <main className="max-w-2xl mx-auto px-4 py-6 pb-safe space-y-6">
          {Header}
          {me && (
            <div className="casino-card p-5 text-center">
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Your chips</p>
              <p className={`font-display text-4xl font-black ${me.chips < 0 ? "text-red-400" : "logo-gold"}`}>{fmt(me.chips)}</p>
            </div>
          )}
          <div className="casino-card p-5">
            <h2 className="font-serif text-lg font-semibold mb-4 flex items-center gap-2"><Send className="w-4 h-4 text-gold-500" /> Send Chips</h2>
            {others.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">Waiting for others — share <strong className="text-gold-400">{lobby.code}</strong>.</p>
            ) : (
              <>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-4">
                  {others.map((m) => (
                    <button key={m.user_id} type="button" onClick={() => setRecipient(m.user_id)}
                      className={`flex flex-col items-center gap-1 p-2 rounded-xl ${recipient === m.user_id ? "bg-gold-500/15 ring-1 ring-gold-500/60" : "bg-muted/20"}`}>
                      <PlayerAvatar username={m.username} userId={m.user_id} size="sm" />
                      <span className="text-[11px] truncate w-full text-center">{m.username}</span>
                      <span className="text-[10px] text-muted-foreground">{fmt(m.chips)}</span>
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input type="number" inputMode="numeric" min={1} placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} className="flex-1" />
                  <Button variant="gold" onClick={handleSend} disabled={sending || !recipient || !amount}>
                    {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </Button>
                </div>
              </>
            )}
          </div>
          <Button variant="outline" size="lg" className="w-full border-destructive/40 text-destructive hover:bg-destructive/10" onClick={handleLeave}>
            <DoorOpen className="w-4 h-4 mr-2" /> Leave Tracker
          </Button>
        </main>
        <Toaster />
      </>
    );
  }

  // ===== Denomination rooms: felt table =====
  return (
    <>
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6 pb-safe space-y-5">
        {Header}

        {/* Felt table — players AND chip handling all happen here */}
        <div className="bj-table px-3 sm:px-5 pt-6 pb-12">
          {/* Center logo — matches the main menu */}
          <div className="flex flex-col items-center text-center mb-5 select-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="Gabe's Chips" className="w-16 h-16 object-contain mb-1" />
            <p className="font-display text-xl sm:text-2xl font-black uppercase logo-gold leading-none">Gabe&apos;s Chips</p>
            <p className="text-[10px] tracking-[0.2em] uppercase text-white/40 mt-1">
              {cfg.game} · {fmtCents(members.reduce((s, m) => s + totalCents(m.chipCounts), 0))} in play
            </p>
          </div>

          {/* Players + their chip stacks */}
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            {members.map((m) => {
              const isMe = m.user_id === currentUserId;
              const isD = m.user_id === dealerId;
              const isSpinTarget = spinning && members[spinIdx]?.user_id === m.user_id;
              return (
                <div key={m.user_id}
                  className={`rounded-xl p-2.5 ${isSpinTarget ? "bg-gold-500/25 ring-2 ring-gold-400" : isD ? "bg-black/40 ring-1 ring-gold-500/40" : isMe ? "bg-black/40 ring-1 ring-gold-500/50" : "bg-black/25"}`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <PlayerAvatar username={m.username} userId={m.user_id} size="sm" />
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold truncate flex items-center gap-1 text-white">
                        {isMe ? "You" : m.username}{isD && <span title="Dealer">👑</span>}
                      </p>
                      {isD ? (
                        <p className={`text-xs font-mono ${m.chips < 0 ? "text-red-400" : "text-gold-400"}`}>{fmtCents(m.chips)}</p>
                      ) : (
                        <p className="text-xs font-mono text-gold-400">{fmtCents(totalCents(m.chipCounts))}</p>
                      )}
                    </div>
                  </div>
                  {isD ? (
                    <p className="text-[10px] text-white/40 uppercase tracking-wide">The house · net</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {sortedCounts(m.chipCounts).map(([v, c]) => (
                        <span key={v} className="flex items-center">
                          <Chip value={v} size={22} />
                          <span className="text-[10px] text-white/70 ml-0.5">×{c}</span>
                        </span>
                      ))}
                      {sortedCounts(m.chipCounts).length === 0 && <span className="text-[10px] text-white/40">no chips</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* On-felt: chip handling */}
          {/* POKER — free-form chip send */}
          {!isBlackjack && (
            <div className="mt-5 pt-4 border-t border-gold-500/15">
              {others.length === 0 ? (
                <p className="text-center text-sm text-white/60 py-2">Waiting for others — share <strong className="text-gold-400">{lobby.code}</strong>.</p>
              ) : (
                <div className="space-y-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gold-400/90 flex items-center gap-2"><Send className="w-3.5 h-3.5" /> Send Chips</p>
                  <div>
                    <p className="text-[11px] text-white/60 mb-2">Send to</p>
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                      {others.map((m) => (
                        <button key={m.user_id} type="button" onClick={() => { setTarget(m.user_id); setTray({}); }}
                          className={`flex flex-col items-center gap-1 p-2 rounded-xl ${target === m.user_id ? "bg-gold-500/20 ring-1 ring-gold-400" : "bg-black/30"}`}>
                          <PlayerAvatar username={m.username} userId={m.user_id} size="sm" />
                          <span className="text-[11px] truncate w-full text-center text-white/90">{m.username}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  {target && (
                    <div>
                      <p className="text-[11px] text-white/60 mb-2">Your chips — tap to add</p>
                      <div className="flex flex-wrap gap-2">
                        {sortedCounts(sourceCounts).map(([v]) => {
                          const avail = availOf(String(v));
                          return (
                            <button key={v} type="button" disabled={avail <= 0} onClick={() => addToTray(String(v))}
                              className={`flex items-center gap-1 rounded-lg px-1.5 py-1 ${avail > 0 ? "hover:bg-black/30 active:scale-95 transition-transform" : "opacity-40"}`}>
                              <Chip value={v} size={30} /><span className="text-[10px] text-white/70">×{avail}</span>
                            </button>
                          );
                        })}
                        {sortedCounts(sourceCounts).length === 0 && <span className="text-xs text-white/50">No chips available.</span>}
                      </div>
                    </div>
                  )}
                  {target && (
                    <div className="rounded-xl bg-black/30 border border-gold-500/20 p-3 min-h-[64px]">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] text-white/60">Sending — tap to remove</span>
                        <span className="text-gold-400 font-mono font-semibold">{fmtCents(trayCents)}</span>
                      </div>
                      {trayCents > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(tray).filter(([, c]) => c > 0).map(([v, c]) => (
                            <button key={v} type="button" onClick={() => removeFromTray(v)} className="flex items-center gap-1">
                              <Chip value={Number(v)} size={28} /><span className="text-[10px] text-white/70">×{c}</span>
                            </button>
                          ))}
                        </div>
                      ) : <p className="text-[11px] text-white/40">Tap your chips above to add them here.</p>}
                    </div>
                  )}
                  <Button variant="gold" size="lg" className="w-full" onClick={sendTray} disabled={sending || !target || trayCents <= 0}>
                    {sending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                    Send chips{trayCents > 0 ? ` (${fmtCents(trayCents)})` : ""}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* BLACKJACK — dealer + hand flow */}
          {isBlackjack && (
            <div className="mt-5 pt-4 border-t border-gold-500/15 space-y-4">
              {(!hasDealer || assignMode) ? (
                <div className="text-center">
                  <p className="text-sm text-white/70 mb-3">{assignMode ? "Tap a player to make them the dealer" : "Pick a dealer"}</p>
                  {assignMode ? (
                    <>
                      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-2">
                        {members.map((m) => (
                          <button key={m.user_id} type="button" onClick={() => assignDealer(m.user_id)}
                            className="flex flex-col items-center gap-1 p-2 rounded-xl bg-black/30 hover:bg-black/50">
                            <PlayerAvatar username={m.username} userId={m.user_id} size="sm" />
                            <span className="text-[11px] truncate w-full text-center text-white/90">{m.user_id === currentUserId ? "You" : m.username}</span>
                          </button>
                        ))}
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setAssignMode(false)}>Cancel</Button>
                    </>
                  ) : (
                    <div className="flex justify-center gap-2">
                      <Button variant="gold" onClick={() => setAssignMode(true)} disabled={members.length < 2}>Assign Dealer</Button>
                      <Button variant="casino" onClick={spinDealer} disabled={spinning || members.length < 2}>
                        <Dices className="w-4 h-4 mr-1.5" /> Random Dealer
                      </Button>
                    </div>
                  )}
                  {members.length < 2 && <p className="text-[11px] text-white/40 mt-2">Need 2+ players to pick a dealer.</p>}
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm text-white flex items-center gap-1.5">
                      👑 <span className="font-semibold">{dealerId === currentUserId ? "You are" : `${nameOf(dealerId!)} is`}</span> the dealer
                    </p>
                    {hand.phase === "idle" && (
                      <Button variant="ghost" size="sm" className="text-white/60" onClick={() => setAssignMode(true)}>Change</Button>
                    )}
                  </div>

                  {/* IDLE */}
                  {hand.phase === "idle" && (amDealer ? (
                    <div className="space-y-2">
                      <Button variant="gold" size="lg" className="w-full" onClick={newHand}>Deal New Hand</Button>
                      {hand.lastHand && (
                        <Button variant="outline" size="sm" className="w-full border-gold-500/40 text-gold-300" onClick={undoLastHand}>
                          <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Undo Last Hand
                        </Button>
                      )}
                    </div>
                  ) : (
                    <p className="text-center text-sm text-white/60 py-2">Waiting for the dealer to deal a new hand…</p>
                  ))}

                  {/* BETTING */}
                  {hand.phase === "betting" && (
                    <div className="space-y-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gold-400/90">Place your bets</p>
                      {amDealer ? (
                        <>
                          <div className="space-y-1.5">
                            {others.map((m) => (
                              <div key={m.user_id} className="flex items-center justify-between text-sm">
                                <span className="text-white/90">{m.username}</span>
                                <span className={m.betCents > 0 ? "text-gold-400 font-mono" : "text-white/40"}>{m.betCents > 0 ? fmtCents(m.betCents) : "waiting…"}</span>
                              </div>
                            ))}
                          </div>
                          <Button variant="gold" size="lg" className="w-full" onClick={startHand} disabled={!anyBet}>Start Hand ({fmtCents(potCents)})</Button>
                        </>
                      ) : (
                        <div className="space-y-3">
                          {me && me.betCents > 0 && (
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-white/80">Your bet: <span className="text-gold-400 font-mono">{fmtCents(me.betCents)}</span></span>
                              <Button variant="ghost" size="sm" onClick={clearBet}>Clear</Button>
                            </div>
                          )}
                          <div>
                            <p className="text-[11px] text-white/60 mb-2">Tap your chips to bet</p>
                            <div className="flex flex-wrap gap-2">
                              {sortedCounts(myCounts).map(([v]) => {
                                const avail = betAvail(String(v));
                                return (
                                  <button key={v} type="button" disabled={avail <= 0} onClick={() => setBetTray((t) => ({ ...t, [String(v)]: (t[String(v)] ?? 0) + 1 }))}
                                    className={`flex items-center gap-1 rounded-lg px-1.5 py-1 ${avail > 0 ? "hover:bg-black/30 active:scale-95 transition-transform" : "opacity-40"}`}>
                                    <Chip value={v} size={30} /><span className="text-[10px] text-white/70">×{avail}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          {betCents > 0 && (
                            <div className="rounded-xl bg-black/30 border border-gold-500/20 p-3">
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-[11px] text-white/60">Your bet — tap to remove</span>
                                <span className="text-gold-400 font-mono font-semibold">{fmtCents(betCents)}</span>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {Object.entries(betTray).filter(([, c]) => c > 0).map(([v, c]) => (
                                  <button key={v} type="button" onClick={() => setBetTray((t) => ({ ...t, [v]: Math.max(0, (t[v] ?? 0) - 1) }))} className="flex items-center gap-1">
                                    <Chip value={Number(v)} size={28} /><span className="text-[10px] text-white/70">×{c}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                          <Button variant="gold" size="lg" className="w-full" onClick={commitBet} disabled={betCents <= 0}>Place Bet ({fmtCents(betCents)})</Button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* PLAYING — dealer resolves */}
                  {hand.phase === "playing" && (
                    <div className="space-y-3">
                      <div className="rounded-xl bg-black/30 border border-gold-500/20 p-3 text-center">
                        <p className="text-[11px] text-white/60">Pot</p>
                        <p className="text-gold-400 font-mono font-bold text-lg">{fmtCents(potCents)}</p>
                      </div>
                      {amDealer ? (
                        <>
                          {others.filter((m) => m.betCents > 0).map((m) => (
                            <div key={m.user_id} className="rounded-lg bg-black/25 p-2.5">
                              <div className="flex items-center justify-between mb-1.5">
                                <span className="text-sm text-white/90">{m.username} · <span className="font-mono text-gold-400">{fmtCents(m.betCents)}</span></span>
                              </div>
                              <div className="grid grid-cols-3 gap-1.5">
                                {(["win", "lose", "bj"] as Outcome[]).map((o) => (
                                  <Button key={o} size="sm" variant={hand.results[m.user_id] === o ? "gold" : "outline"} onClick={() => markResult(m.user_id, o)}>
                                    {o === "win" ? "Win" : o === "lose" ? "Lose" : "Blackjack"}
                                  </Button>
                                ))}
                              </div>
                            </div>
                          ))}
                          <div className="grid grid-cols-2 gap-2">
                            <Button variant="outline" size="sm" onClick={dealerBlackjack}>Dealer Blackjack</Button>
                            <Button variant="ghost" size="sm" onClick={undoMark} disabled={hand.marked.length === 0}>
                              <RotateCcw className="w-3.5 h-3.5 mr-1" /> Undo
                            </Button>
                          </div>
                          <Button variant="gold" size="lg" className="w-full" onClick={payOut} disabled={!allMarked}>Pay Out &amp; End Hand</Button>
                        </>
                      ) : (
                        <div className="text-center text-sm text-white/70 py-1">
                          {me && me.betCents > 0 ? (
                            <p>Your bet <span className="font-mono text-gold-400">{fmtCents(me.betCents)}</span> — {hand.results[currentUserId]
                              ? <strong className="uppercase text-white">{hand.results[currentUserId] === "bj" ? "Blackjack!" : hand.results[currentUserId]}</strong>
                              : "waiting on the dealer…"}</p>
                          ) : <p>Sitting out this hand.</p>}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Transfer log / hand history */}
        <div className="casino-card p-5">
          <h2 className="font-serif text-lg font-semibold mb-3 flex items-center gap-2">
            <History className="w-4 h-4 text-gold-500" /> {isBlackjack ? "Hand History" : "Recent Transfers"}
          </h2>
          {transfers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-2">{isBlackjack ? "No hands played yet." : "No chips moved yet."}</p>
          ) : (
            <div className="divide-y divide-border/40">
              {transfers.map((t) => {
                if (t.note) {
                  // Blackjack hand outcome
                  const player = t.note === "lost" ? t.from_user : t.to_user;
                  const who = player === currentUserId ? "You" : nameOf(player);
                  const color = t.note === "lost" ? "text-red-400" : t.note === "blackjack" ? "text-gold-400" : "text-green-400";
                  const label = t.note === "blackjack" ? "blackjack" : t.note;
                  const sign = t.note === "lost" ? "−" : "+";
                  return (
                    <div key={t.id} className="flex items-center justify-between py-2 text-sm">
                      <span className="min-w-0 truncate">
                        <span className="font-semibold">{who}</span> <span className={color}>{label}</span>
                      </span>
                      <span className={`font-mono font-semibold shrink-0 ${color}`}>{sign}{fmtCents(t.amount)}</span>
                    </div>
                  );
                }
                return (
                  <div key={t.id} className="flex items-center justify-between py-2 text-sm">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className={`truncate ${t.from_user === currentUserId ? "text-gold-400 font-semibold" : ""}`}>{t.from_user === currentUserId ? "You" : nameOf(t.from_user)}</span>
                      <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className={`truncate ${t.to_user === currentUserId ? "text-gold-400 font-semibold" : ""}`}>{t.to_user === currentUserId ? "You" : nameOf(t.to_user)}</span>
                    </span>
                    <span className="text-gold-400 font-semibold shrink-0 font-mono">{fmtCents(t.amount)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <Button variant="outline" size="lg" className="w-full border-destructive/40 text-destructive hover:bg-destructive/10" onClick={handleLeave}>
          <DoorOpen className="w-4 h-4 mr-2" /> Leave Tracker
        </Button>
      </main>
      <Toaster />
    </>
  );
}
