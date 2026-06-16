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
  Copy, Check, Coins, Loader2, Send, DoorOpen, History, ArrowRight,
} from "lucide-react";
import { formatChips } from "@/lib/utils";
import type { Database } from "@/lib/supabase";

type Lobby = Database["public"]["Tables"]["lobbies"]["Row"];

interface Member {
  user_id: string;
  username: string;
  chips: number; // per-room stack (not the global all-time total)
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

export function ChipTracker({ lobby, currentUserId }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [recipient, setRecipient] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const router = useRouter();
  const supabase = createClient();
  const { toast } = useToast();
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>["channel"]> | null>(null);

  const nameOf = (uid: string) => members.find((m) => m.user_id === uid)?.username ?? "Player";

  const loadMembers = useCallback(async () => {
    const { data } = await supabase.from("lobby_players").select("user_id, chips").eq("lobby_id", lobby.id);
    if (!data) return;
    const withProfiles = await Promise.all(
      data.map(async (lp) => {
        const { data: profile } = await supabase.from("profiles").select("username").eq("id", lp.user_id).single();
        return { user_id: lp.user_id, username: profile?.username ?? "Player", chips: lp.chips ?? 0 };
      })
    );
    setMembers(withProfiles);
  }, [supabase, lobby.id]);

  const loadTransfers = useCallback(async () => {
    const { data } = await supabase
      .from("chip_transfers")
      .select("*")
      .eq("lobby_id", lobby.id)
      .order("created_at", { ascending: false })
      .limit(20);
    if (data) setTransfers(data as TransferRow[]);
  }, [supabase, lobby.id]);

  // Auto-join the room on entry, then load everything
  useEffect(() => {
    (async () => {
      const { data: existing } = await supabase
        .from("lobby_players")
        .select("user_id")
        .eq("lobby_id", lobby.id)
        .eq("user_id", currentUserId)
        .maybeSingle();
      if (!existing) {
        // New member starts with a fresh stack = the room's buy-in
        await supabase.from("lobby_players").insert({ lobby_id: lobby.id, user_id: currentUserId, chips: lobby.buy_in });
      }
      await Promise.all([loadMembers(), loadTransfers()]);
      setLoading(false);
    })();
  }, [supabase, lobby.id, currentUserId, loadMembers, loadTransfers]);

  // Realtime: refresh on membership changes; broadcast-driven transfer refresh
  useEffect(() => {
    const channel = supabase
      .channel(`tracker-${lobby.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lobby_players", filter: `lobby_id=eq.${lobby.id}` },
        () => loadMembers()
      )
      .on("broadcast", { event: "transfer" }, ({ payload }) => {
        const p = payload as { from?: string; to?: string; amount?: number };
        loadMembers();
        loadTransfers();
        if (p.to === currentUserId) {
          const money = !!(lobby.tracker_config as { money?: boolean } | null)?.money;
          const amt = p.amount ?? 0;
          const disp = money ? `$${(amt / 100).toFixed(2)}` : `${amt.toLocaleString()} chips`;
          toast({ title: "💰 Chips received", description: `${p.from} sent you ${disp}` });
        }
      })
      .subscribe();
    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); channelRef.current = null; };
  }, [supabase, lobby.id, currentUserId, loadMembers, loadTransfers, toast]);

  const me = members.find((m) => m.user_id === currentUserId);

  const denominations =
    (lobby.tracker_config as { denominations?: { value: number; count: number }[] } | null)?.denominations ?? [];
  const denomTotal = denominations.reduce((s, d) => s + d.value * d.count, 0);

  // Denomination rooms track real money (stored in cents); others use whole chips.
  const moneyMode = denominations.length > 0;
  const fmt = (units: number) =>
    moneyMode
      ? `${units < 0 ? "−" : ""}$${(Math.abs(units) / 100).toFixed(2)}`
      : `${units < 0 ? "−" : ""}${formatChips(Math.abs(units))}`;
  const quickAmounts = moneyMode ? [0.5, 1, 5, 10] : [10, 25, 50, 100];

  const handleSend = async () => {
    const amt = Number(amount);
    if (!recipient || !Number.isFinite(amt) || amt <= 0) {
      toast({ title: "Enter an amount and pick a recipient", variant: "destructive" });
      return;
    }
    // In money mode the input is dollars; store as cents.
    const units = moneyMode ? Math.round(amt * 100) : Math.floor(amt);
    setSending(true);
    const { error } = await supabase.rpc("transfer_chips", {
      p_lobby_id: lobby.id,
      p_to: recipient,
      p_amount: units,
    });
    if (error) {
      toast({ title: "Transfer failed", description: error.message, variant: "destructive" });
      setSending(false);
      return;
    }
    // Tell the room (live refresh + recipient toast)
    channelRef.current?.send({
      type: "broadcast",
      event: "transfer",
      payload: { from: me?.username ?? "Someone", to: recipient, amount: units },
    });
    setAmount("");
    setRecipient(null);
    await Promise.all([loadMembers(), loadTransfers()]);
    toast({ title: "Chips sent", description: `${fmt(units)} → ${nameOf(recipient)}` });
    setSending(false);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(lobby.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleLeave = () => router.push("/");

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gold-400" />
      </div>
    );
  }

  const others = members.filter((m) => m.user_id !== currentUserId);

  return (
    <>
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6 pb-safe space-y-6">
        {/* Header */}
        <div className="casino-card p-6">
          <div className="deco-chevrons mb-5" />
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-gold-400/80 mb-1">Chip Tracker</p>
              <h1 className="font-serif text-2xl sm:text-3xl font-bold">{lobby.name}</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Real cards, real table — the app just keeps the chips honest.
              </p>
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

        {/* Your balance */}
        {me && (
          <div className="casino-card p-5 text-center">
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Your chips</p>
            <p className={`font-display text-4xl font-black ${me.chips < 0 ? "text-red-400" : "logo-gold"}`}>
              {fmt(me.chips)}
            </p>
          </div>
        )}

        {/* Physical chip set (Poker) */}
        {denominations.length > 0 && (
          <div className="casino-card p-5">
            <h2 className="font-serif text-lg font-semibold mb-1 flex items-center gap-2">
              <Coins className="w-4 h-4 text-gold-500" /> Buy-in Chip Set
            </h2>
            <p className="text-xs text-muted-foreground mb-3">
              Each player&apos;s stack — divide your physical chips like this.
            </p>
            <div className="space-y-1.5">
              {denominations.map((d, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-gold-400 w-14">${d.value.toFixed(2)}</span>
                    <span className="text-muted-foreground">× {d.count}</span>
                  </span>
                  <span className="font-mono text-muted-foreground">${(d.value * d.count).toFixed(2)}</span>
                </div>
              ))}
              <div className="deco-divider"><span className="text-[10px]">◆</span></div>
              <div className="flex items-center justify-between text-sm font-semibold">
                <span>Total per player</span>
                <span className="text-gold-400 font-mono">${denomTotal.toFixed(2)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Send chips */}
        <div className="casino-card p-5">
          <h2 className="font-serif text-lg font-semibold mb-4 flex items-center gap-2">
            <Send className="w-4 h-4 text-gold-500" /> Send Chips
          </h2>

          {others.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Waiting for others to join — share the code <strong className="text-gold-400">{lobby.code}</strong>.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground mb-2">To:</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-4">
                {others.map((m) => (
                  <button
                    key={m.user_id}
                    type="button"
                    onClick={() => setRecipient(m.user_id)}
                    className={`flex flex-col items-center gap-1 p-2 rounded-xl transition-all ${
                      recipient === m.user_id ? "bg-gold-500/15 ring-1 ring-gold-500/60" : "bg-muted/20 hover:bg-muted/40"
                    }`}
                  >
                    <PlayerAvatar username={m.username} userId={m.user_id} size="sm" />
                    <span className="text-[11px] truncate w-full text-center">{m.username}</span>
                    <span className={`text-[10px] ${m.chips < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                      {fmt(m.chips)}
                    </span>
                  </button>
                ))}
              </div>

              <div className="flex gap-2 mb-3">
                <Input
                  type="number"
                  inputMode={moneyMode ? "decimal" : "numeric"}
                  step={moneyMode ? "0.25" : "1"}
                  min={moneyMode ? 0.01 : 1}
                  placeholder={moneyMode ? "$ amount" : "Amount"}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="flex-1"
                />
                <Button variant="gold" onClick={handleSend} disabled={sending || !recipient || !amount}>
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {quickAmounts.map((q) => (
                  <Button key={q} type="button" variant="ghost" size="sm" className="text-xs" onClick={() => setAmount(String(q))}>
                    <Coins className="w-3 h-3 mr-1 text-gold-500" />{moneyMode ? `$${q}` : q}
                  </Button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Transfer log */}
        <div className="casino-card p-5">
          <h2 className="font-serif text-lg font-semibold mb-4 flex items-center gap-2">
            <History className="w-4 h-4 text-gold-500" /> Recent Transfers
          </h2>
          {transfers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No chips moved yet.</p>
          ) : (
            <div className="divide-y divide-border/40">
              {transfers.map((t) => (
                <div key={t.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={`truncate ${t.from_user === currentUserId ? "text-gold-400 font-semibold" : ""}`}>
                      {t.from_user === currentUserId ? "You" : nameOf(t.from_user)}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className={`truncate ${t.to_user === currentUserId ? "text-gold-400 font-semibold" : ""}`}>
                      {t.to_user === currentUserId ? "You" : nameOf(t.to_user)}
                    </span>
                  </span>
                  <span className="text-gold-400 font-semibold shrink-0">{fmt(t.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <Button
          variant="outline"
          size="lg"
          className="w-full border-destructive/40 text-destructive hover:bg-destructive/10"
          onClick={handleLeave}
        >
          <DoorOpen className="w-4 h-4 mr-2" /> Leave Tracker
        </Button>
      </main>

      <Toaster />
    </>
  );
}
