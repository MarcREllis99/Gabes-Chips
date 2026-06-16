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
  Copy, Check, Loader2, Send, DoorOpen, History, ArrowRight, Spade, Dices,
} from "lucide-react";
import { formatChips } from "@/lib/utils";
import type { Database } from "@/lib/supabase";

type Lobby = Database["public"]["Tables"]["lobbies"]["Row"];

interface Member {
  user_id: string;
  username: string;
  chips: number;                       // whole-chip total (non-denom rooms)
  chipCounts: Record<string, number>;  // per-denomination counts (denom rooms)
}
interface TransferRow {
  id: string;
  from_user: string;
  to_user: string;
  amount: number;
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
    const { data } = await supabase.from("lobby_players").select("user_id, chips, chip_counts").eq("lobby_id", lobby.id);
    if (!data) return;
    const withProfiles = await Promise.all(
      data.map(async (lp) => {
        const { data: profile } = await supabase.from("profiles").select("username").eq("id", lp.user_id).single();
        return {
          user_id: lp.user_id,
          username: profile?.username ?? "Player",
          chips: lp.chips ?? 0,
          chipCounts: (lp.chip_counts as Record<string, number>) ?? {},
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
        (payload) => setDealerId((payload.new as Lobby).dealer_id))
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
        await supabase.from("lobbies").update({ dealer_id: winner.user_id }).eq("id", lobby.id);
        setDealerId(winner.user_id);
        channelRef.current?.send({ type: "broadcast", event: "dealer", payload: { name: winner.username } });
      }
    }, 110);
  };

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
  const canCompose = isBlackjack ? amDealer && !!target : !!target;

  return (
    <>
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6 pb-safe space-y-5">
        {Header}

        {/* Felt table */}
        <div className="bj-table px-3 sm:px-6 pt-6 pb-10">
          <div className="flex flex-col items-center text-center mb-5 select-none">
            <div className="w-10 h-10 rotate-45 bg-black/30 border border-gold-500/50 flex items-center justify-center mb-2">
              <Spade className="w-5 h-5 text-gold-400 -rotate-45" />
            </div>
            <p className="font-display text-lg sm:text-xl font-black uppercase logo-gold leading-none">Gabe&apos;s Chips</p>
            <p className="text-[10px] tracking-[0.2em] uppercase text-white/40 mt-1">
              {cfg.game} · {fmtCents(members.reduce((s, m) => s + totalCents(m.chipCounts), 0))} in play
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            {members.map((m) => {
              const isMe = m.user_id === currentUserId;
              const isD = m.user_id === dealerId;
              const isSpinTarget = spinning && members[spinIdx]?.user_id === m.user_id;
              return (
                <div key={m.user_id}
                  className={`rounded-xl p-2.5 ${isSpinTarget ? "bg-gold-500/25 ring-2 ring-gold-400" : isMe ? "bg-black/40 ring-1 ring-gold-500/50" : "bg-black/25"}`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <PlayerAvatar username={m.username} userId={m.user_id} size="sm" />
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold truncate flex items-center gap-1">
                        {isMe ? "You" : m.username}{isD && <span title="Dealer">👑</span>}
                      </p>
                      <p className="text-xs font-mono text-gold-400">{fmtCents(totalCents(m.chipCounts))}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {sortedCounts(m.chipCounts).map(([v, c]) => (
                      <span key={v} className="flex items-center">
                        <Chip value={v} size={22} />
                        <span className="text-[10px] text-white/70 ml-0.5">×{c}</span>
                      </span>
                    ))}
                    {sortedCounts(m.chipCounts).length === 0 && <span className="text-[10px] text-white/40">no chips</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Blackjack: dealer roulette */}
        {isBlackjack && (
          <div className="casino-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-serif font-semibold flex items-center gap-2"><Dices className="w-4 h-4 text-gold-500" /> Dealer</p>
                <p className="text-xs text-muted-foreground">
                  {hasDealer ? <>👑 {dealerId === currentUserId ? "You are" : `${nameOf(dealerId!)} is`} the dealer — they give &amp; take chips.</> : "No dealer yet — spin to pick one."}
                </p>
              </div>
              <Button variant="casino" onClick={spinDealer} disabled={spinning || members.length < 2}>
                <Dices className="w-4 h-4 mr-2" />{hasDealer ? "Re-spin" : "Spin"}
              </Button>
            </div>
          </div>
        )}

        {/* Composer */}
        {isBlackjack && !amDealer ? (
          <div className="casino-card p-5 text-center text-sm text-muted-foreground">
            {hasDealer ? "The dealer manages the chips this round." : "Waiting for a dealer to be picked."}
          </div>
        ) : (
          <div className="casino-card p-5 space-y-4">
            <h2 className="font-serif text-lg font-semibold flex items-center gap-2">
              <Send className="w-4 h-4 text-gold-500" /> {isBlackjack ? "Dealer Chips" : "Send Chips"}
            </h2>

            {others.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-2">Waiting for others — share <strong className="text-gold-400">{lobby.code}</strong>.</p>
            ) : (
              <>
                {/* pick player */}
                <div>
                  <p className="text-xs text-muted-foreground mb-2">{isBlackjack ? "Player" : "Send to"}</p>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                    {others.map((m) => (
                      <button key={m.user_id} type="button" onClick={() => { setTarget(m.user_id); setTray({}); }}
                        className={`flex flex-col items-center gap-1 p-2 rounded-xl ${target === m.user_id ? "bg-gold-500/15 ring-1 ring-gold-500/60" : "bg-muted/20"}`}>
                        <PlayerAvatar username={m.username} userId={m.user_id} size="sm" />
                        <span className="text-[11px] truncate w-full text-center">{m.username}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* blackjack give/take toggle */}
                {isBlackjack && target && (
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant={mode === "give" ? "gold" : "outline"} size="sm" onClick={() => { setMode("give"); setTray({}); }}>Give to {nameOf(target)}</Button>
                    <Button variant={mode === "take" ? "gold" : "outline"} size="sm" onClick={() => { setMode("take"); setTray({}); }}>Take from {nameOf(target)}</Button>
                  </div>
                )}

                {/* source chips */}
                {target && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-2">
                      {isBlackjack ? (mode === "give" ? "Your chips (tap to give)" : `${nameOf(target)}'s chips (tap to take)`) : "Your chips (tap to add)"}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {sortedCounts(sourceCounts).map(([v]) => {
                        const avail = availOf(String(v));
                        return (
                          <button key={v} type="button" disabled={avail <= 0} onClick={() => addToTray(String(v))}
                            className={`flex items-center gap-1 rounded-lg px-1.5 py-1 ${avail > 0 ? "hover:bg-muted/40" : "opacity-40"}`}>
                            <Chip value={v} size={28} />
                            <span className="text-[10px] text-muted-foreground">×{avail}</span>
                          </button>
                        );
                      })}
                      {sortedCounts(sourceCounts).length === 0 && <span className="text-xs text-muted-foreground">No chips available.</span>}
                    </div>
                  </div>
                )}

                {/* tray */}
                {target && trayCents > 0 && (
                  <div className="rounded-xl bg-muted/20 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-muted-foreground">Selected (tap to remove)</span>
                      <span className="text-gold-400 font-mono font-semibold">{fmtCents(trayCents)}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(tray).filter(([, c]) => c > 0).map(([v, c]) => (
                        <button key={v} type="button" onClick={() => removeFromTray(v)} className="flex items-center gap-1">
                          <Chip value={Number(v)} size={26} /><span className="text-[10px] text-white/70">×{c}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <Button variant="gold" size="lg" className="w-full" onClick={sendTray} disabled={sending || !canCompose || trayCents <= 0}>
                  {sending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                  {isBlackjack ? (mode === "give" ? "Give chips" : "Take chips") : "Send chips"} {trayCents > 0 ? `(${fmtCents(trayCents)})` : ""}
                </Button>
              </>
            )}
          </div>
        )}

        {/* Transfer log */}
        <div className="casino-card p-5">
          <h2 className="font-serif text-lg font-semibold mb-3 flex items-center gap-2"><History className="w-4 h-4 text-gold-500" /> Recent Transfers</h2>
          {transfers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-2">No chips moved yet.</p>
          ) : (
            <div className="divide-y divide-border/40">
              {transfers.map((t) => (
                <div key={t.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={`truncate ${t.from_user === currentUserId ? "text-gold-400 font-semibold" : ""}`}>{t.from_user === currentUserId ? "You" : nameOf(t.from_user)}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className={`truncate ${t.to_user === currentUserId ? "text-gold-400 font-semibold" : ""}`}>{t.to_user === currentUserId ? "You" : nameOf(t.to_user)}</span>
                  </span>
                  <span className="text-gold-400 font-semibold shrink-0 font-mono">{fmtCents(t.amount)}</span>
                </div>
              ))}
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
