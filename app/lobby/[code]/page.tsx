"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Navbar } from "@/components/navbar";
import { PlayerAvatar } from "@/components/player-avatar";
import { ChipTracker } from "@/components/chip-tracker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/components/ui/use-toast";
import {
  Copy, Check, Users, Crown, Loader2,
  DoorOpen, Play, Clock, Trash2, Dices, RotateCcw,
} from "lucide-react";
import { GAME_INFO, GAME_LIST, type GameType } from "@/lib/games";
import type { Database } from "@/lib/supabase";

type Lobby = Database["public"]["Tables"]["lobbies"]["Row"];
type Profile = Database["public"]["Tables"]["profiles"]["Row"];

interface LobbyPlayer {
  id: string;
  user_id: string;
  joined_at: string;
  profile: Profile;
}

export default function LobbyPage() {
  const params = useParams();
  const code = (params.code as string).toUpperCase();

  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [currentUser, setCurrentUser] = useState<{ id: string } | null>(null);
  const [currentProfile, setCurrentProfile] = useState<Profile | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [starting, setStarting] = useState(false);
  const [disbanding, setDisbanding] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [stakeInput, setStakeInput] = useState("100");
  const [spinning, setSpinning] = useState(false);
  const [spinIndex, setSpinIndex] = useState(0);

  const router = useRouter();
  const supabase = createClient();
  const { toast } = useToast();
  const prevDealerRef = useRef<string | null | undefined>(undefined);
  const spinTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadPlayers = useCallback(async (lobbyId: string) => {
    const { data } = await supabase
      .from("lobby_players")
      .select("*")
      .eq("lobby_id", lobbyId)
      .order("joined_at");

    if (!data) return;

    const withProfiles = await Promise.all(
      data.map(async (lp) => {
        const { data: profile } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", lp.user_id)
          .single();
        return { ...lp, profile: profile! };
      })
    );
    setPlayers(withProfiles.filter((p) => p.profile));
  }, [supabase]);

  const loadLobby = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.push("/auth/login"); return; }
    setCurrentUser(user);

    const [profileResult, lobbyResult] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", user.id).single(),
      supabase.from("lobbies").select("*").eq("code", code).single(),
    ]);

    setCurrentProfile(profileResult.data);

    if (!lobbyResult.data) {
      toast({ title: "Lobby not found", variant: "destructive" });
      router.push("/");
      return;
    }

    const lobby = lobbyResult.data;
    setLobby(lobby);

    if (lobby.status === "active") {
      router.push(`/lobby/${code}/game`);
      return;
    }

    await loadPlayers(lobby.id);
    setLoading(false);
  }, [code, router, supabase, toast, loadPlayers]);

  useEffect(() => {
    loadLobby();
  }, [loadLobby]);

  // Realtime subscription
  useEffect(() => {
    if (!lobby) return;

    const channel = supabase
      .channel(`lobby-${lobby.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lobby_players", filter: `lobby_id=eq.${lobby.id}` },
        () => loadPlayers(lobby.id)
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "lobbies", filter: `id=eq.${lobby.id}` },
        (payload) => {
          const updated = payload.new as Lobby;
          setLobby(updated);
          if (updated.status === "active") {
            router.push(`/lobby/${code}/game`);
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "lobbies" },
        (payload) => {
          if ((payload.old as { id?: string }).id === lobby.id) {
            toast({ title: "Lobby disbanded", description: "The host closed this lobby." });
            router.push("/");
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [lobby, supabase, loadPlayers, router, code, toast]);

  const isInLobby = players.some((p) => p.user_id === currentUser?.id);
  const isHost = lobby?.host_id === currentUser?.id;
  const isFull = players.length >= (lobby?.max_players ?? 0);
  const isDealerGame = lobby ? (lobby.game_type === "blackjack" || lobby.game_type === "free_bet") : false;
  // The chosen dealer, only if they're still in the lobby
  const dealerPlayer = lobby?.dealer_id
    ? players.find((p) => p.user_id === lobby.dealer_id)
    : undefined;
  const hasDealer = isDealerGame && !!dealerPlayer;
  // Bankroll (multi-round) games: the stake is a starting buy-in, not a one-shot ante.
  const isBankroll = lobby
    ? ["blackjack", "free_bet", "texas_holdem", "three_card"].includes(lobby.game_type)
    : false;
  // A human dealer needs at least one other player to bank against
  const minPlayers = lobby
    ? (hasDealer ? 2 : (GAME_INFO[lobby.game_type]?.minPlayers ?? 2))
    : 2;

  // Animate a roulette spin whenever the dealer changes (for everyone)
  useEffect(() => {
    const newDealer = lobby?.dealer_id ?? null;
    if (prevDealerRef.current === undefined) {
      prevDealerRef.current = newDealer; // initial load — no animation
      return;
    }
    if (newDealer && newDealer !== prevDealerRef.current && players.length > 0) {
      const landIndex = Math.max(0, players.findIndex((p) => p.user_id === newDealer));
      setSpinning(true);
      let ticks = 0;
      const totalTicks = 20;
      if (spinTimer.current) clearInterval(spinTimer.current);
      spinTimer.current = setInterval(() => {
        ticks++;
        if (ticks >= totalTicks) {
          if (spinTimer.current) clearInterval(spinTimer.current);
          setSpinIndex(landIndex);
          setSpinning(false);
        } else {
          setSpinIndex(ticks % players.length);
        }
      }, 110);
    }
    prevDealerRef.current = newDealer;
    return () => { if (spinTimer.current) clearInterval(spinTimer.current); };
  }, [lobby?.dealer_id, players]);

  const handleSpinDealer = async () => {
    if (!lobby || !isHost || players.length < 2) {
      toast({ title: "Need 2+ players", description: "A dealer needs at least one player to bank against.", variant: "destructive" });
      return;
    }
    const winner = players[Math.floor(Math.random() * players.length)];
    const { error } = await supabase
      .from("lobbies")
      .update({ dealer_id: winner.user_id })
      .eq("id", lobby.id);
    if (error) {
      toast({ title: "Couldn't pick a dealer", description: error.message, variant: "destructive" });
    }
  };

  const handleJoin = async () => {
    if (!currentUser || !lobby) return;

    setJoining(true);

    const { error } = await supabase
      .from("lobby_players")
      .insert({ lobby_id: lobby.id, user_id: currentUser.id });

    if (error) {
      toast({ title: "Failed to join", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Joined!", description: "The host sets the stake when the game starts." });
    }

    setJoining(false);
  };

  const handleLeave = async () => {
    if (!currentUser || !lobby) return;

    // If the leaving player was the chosen dealer, clear the pick
    if (lobby.dealer_id === currentUser.id) {
      await supabase.from("lobbies").update({ dealer_id: null }).eq("id", lobby.id);
    }

    await supabase.from("lobby_players").delete().eq("lobby_id", lobby.id).eq("user_id", currentUser.id);

    router.push("/");
  };

  const handleDisband = async () => {
    if (!lobby || !isHost) return;
    if (!window.confirm("Disband this lobby for everyone?")) return;

    setDisbanding(true);
    const { error } = await supabase.rpc("disband_lobby", { p_lobby_id: lobby.id });

    if (error) {
      toast({ title: "Failed to disband", description: error.message, variant: "destructive" });
      setDisbanding(false);
      return;
    }

    router.push("/");
  };

  // Post-game continuation: bring the lobby back to the waiting room for
  // another game (any type) with the same group — chips carry via balance.
  const handlePlayAgain = async (gameType: GameType) => {
    if (!lobby || !isHost) return;
    setReplaying(true);
    const { error } = await supabase.rpc("reset_lobby", { p_lobby_id: lobby.id, p_game_type: gameType });
    if (error) {
      toast({ title: "Couldn't start another game", description: error.message, variant: "destructive" });
      setReplaying(false);
      return;
    }
    setReplaying(false);
  };

  const handleStartGame = async () => {
    if (!lobby || !isHost) return;
    if (players.length < minPlayers) {
      toast({ title: `Need at least ${minPlayers} player${minPlayers > 1 ? "s" : ""}`, description: "Wait for someone to join!", variant: "destructive" });
      return;
    }
    if (players.length > GAME_INFO[lobby.game_type].maxPlayers) {
      toast({ title: "Too many players", description: `${GAME_INFO[lobby.game_type].name} supports ${GAME_INFO[lobby.game_type].limit}.`, variant: "destructive" });
      return;
    }
    // A stale dealer pick (dealer left) must be re-spun or cleared
    if (isDealerGame && lobby.dealer_id && !dealerPlayer) {
      toast({ title: "Dealer left the lobby", description: "Re-spin the dealer roulette before starting.", variant: "destructive" });
      return;
    }

    const stake = Number(stakeInput);
    if (!Number.isInteger(stake) || stake <= 0) {
      toast({ title: "Set a stake", description: "Enter how many chips each player puts in.", variant: "destructive" });
      return;
    }

    setStarting(true);

    const { error } = await supabase.rpc("start_game", {
      p_lobby_id: lobby.id,
      p_game_type: lobby.game_type,
      p_stake: stake,
    });

    if (error) {
      toast({ title: "Failed to start game", description: error.message, variant: "destructive" });
      setStarting(false);
      return;
    }

    router.push(`/lobby/${code}/game`);
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gold-400" />
      </div>
    );
  }

  if (!lobby) return null;

  // Chip Tracker rooms render their own ledger UI instead of a game lobby
  if (lobby.game_type === "chip_tracker" && currentUser) {
    return <ChipTracker lobby={lobby} currentUserId={currentUser.id} />;
  }

  return (
    <>
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="casino-card p-6 mb-6">
          <div className="deco-chevrons mb-5" />
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
            <div>
              <h1 className="font-serif text-2xl sm:text-3xl font-bold mb-1">{lobby.name}</h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Users className="w-3.5 h-3.5" />
                  {players.length}/{lobby.max_players} players
                </span>
                <span>
                  {GAME_INFO[lobby.game_type].emoji} {GAME_INFO[lobby.game_type].name}
                </span>
              </div>
            </div>
            <div className="flex flex-row sm:flex-col items-center sm:items-end gap-2 shrink-0">
              <button
                onClick={handleCopyCode}
                className="lobby-code flex items-center gap-2 hover:border-gold-500/60 transition-colors"
                title="Click to copy"
              >
                {code}
                {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 opacity-50" />}
              </button>
              <span className="text-xs text-muted-foreground">Share this code</span>
            </div>
          </div>

          <div className="flex items-center gap-2 p-3 bg-muted/30 rounded-lg text-sm text-muted-foreground">
            <Clock className="w-4 h-4 text-gold-500 shrink-0" />
            <span>
              {lobby.status === "finished"
                ? "Game over — your chips carried over. Play another game with this group, or head out."
                : "Waiting for players… The host hands out chips and starts the game."}
            </span>
          </div>
        </div>

        {/* Players */}
        <div className="casino-card p-6 mb-6">
          <h2 className="font-serif text-lg font-semibold mb-4 flex items-center gap-2">
            <Users className="w-4 h-4 text-gold-500" />
            Players at the Table
          </h2>

          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 sm:gap-4">
            {players.map((lp) => {
              const isDealer = isDealerGame && lobby.dealer_id === lp.user_id;
              return (
                <div
                  key={lp.id}
                  className={`flex flex-col items-center gap-2 p-2 sm:p-3 rounded-xl ${
                    isDealer ? "bg-gold-500/10 ring-1 ring-gold-500/50" : "bg-muted/20"
                  }`}
                >
                  <PlayerAvatar
                    username={lp.profile.username}
                    userId={lp.user_id}
                    size="lg"
                    isHost={lp.user_id === lobby.host_id}
                  />
                  <span className="text-xs font-medium truncate w-full text-center">
                    {lp.profile.username}
                    {lp.user_id === currentUser?.id && (
                      <span className="text-gold-400 ml-1">(you)</span>
                    )}
                  </span>
                  {isDealer && (
                    <span className="text-[10px] font-bold uppercase tracking-wide text-gold-400">
                      👑 Dealer
                    </span>
                  )}
                </div>
              );
            })}

            {/* Empty slots */}
            {Array.from({ length: lobby.max_players - players.length }).map((_, i) => (
              <div key={`empty-${i}`} className="flex flex-col items-center gap-2 p-2 sm:p-3 border-2 border-dashed border-border/40 rounded-xl">
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full border-2 border-dashed border-border/40 flex items-center justify-center text-muted-foreground/30">
                  ?
                </div>
                <span className="text-xs text-muted-foreground/40">Empty</span>
              </div>
            ))}
          </div>
        </div>

        {/* Post-game continuation: play another game with the same group */}
        {lobby.status === "finished" && (
          <div className="casino-card p-6 mb-6">
            <h2 className="font-serif text-lg font-semibold mb-1 flex items-center gap-2">
              <RotateCcw className="w-4 h-4 text-gold-500" />
              Play Another Game
            </h2>
            <p className="text-xs text-muted-foreground mb-4">
              Everyone keeps their chips. {isHost ? "Pick the next game for this group:" : "The host is choosing the next game…"}
            </p>

            {isHost ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {GAME_LIST.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => handlePlayAgain(g.id)}
                    disabled={replaying}
                    className="casino-card p-4 text-left hover:border-gold-500/50 transition-all disabled:opacity-50"
                  >
                    <div className="text-2xl mb-1">{g.emoji}</div>
                    <div className="font-display text-sm font-bold uppercase">{g.name}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">{g.limit}</div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm py-4">
                <Loader2 className="w-4 h-4 animate-spin" />
                Waiting for the host…
              </div>
            )}

            <Button
              variant="outline"
              size="lg"
              className="w-full mt-4"
              onClick={() => router.push("/")}
            >
              <DoorOpen className="w-4 h-4 mr-2" /> Leave for the Menu
            </Button>
          </div>
        )}

        {/* Dealer Roulette — for blackjack & free bet, visible to everyone */}
        {lobby.status === "waiting" && isDealerGame && (
          <div className="casino-card p-6 mb-6">
            <h2 className="font-serif text-lg font-semibold mb-1 flex items-center gap-2">
              <Dices className="w-4 h-4 text-gold-500" />
              Dealer Roulette
            </h2>
            <p className="text-xs text-muted-foreground mb-4">
              Can&apos;t decide who deals? Spin to pick a dealer — they buy in like everyone
              else and bank the table, winning or losing chips against the other players.
            </p>

            {/* Spinner stage */}
            <div className="bg-muted/20 rounded-xl p-4 mb-4 min-h-[88px] flex items-center justify-center">
              {spinning ? (
                <div className="flex flex-col items-center gap-2 animate-pulse">
                  <PlayerAvatar
                    username={players[spinIndex]?.profile.username ?? "?"}
                    userId={players[spinIndex]?.user_id ?? "spin"}
                    size="lg"
                  />
                  <span className="text-sm font-semibold text-gold-400">
                    {players[spinIndex]?.profile.username ?? "…"}
                  </span>
                </div>
              ) : hasDealer && dealerPlayer ? (
                <div className="flex flex-col items-center gap-1.5">
                  <div className="relative">
                    <PlayerAvatar
                      username={dealerPlayer.profile.username}
                      userId={dealerPlayer.user_id}
                      size="lg"
                    />
                    <span className="absolute -top-2 -right-2 text-lg">👑</span>
                  </div>
                  <span className="font-display font-bold uppercase text-gold-400">
                    {dealerPlayer.profile.username}
                    {dealerPlayer.user_id === currentUser?.id && " (You)"}
                  </span>
                  <span className="text-[11px] text-muted-foreground">banks the table</span>
                </div>
              ) : isDealerGame && lobby.dealer_id && !dealerPlayer ? (
                <span className="text-sm text-muted-foreground">
                  The chosen dealer left — {isHost ? "spin again." : "waiting for the host to re-spin."}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground text-center">
                  No dealer yet — {isHost ? "spin to pick one, or start without one to play the automated house dealer." : "the host will spin (or play the automated house dealer)."}
                </span>
              )}
            </div>

            {isHost && (
              <Button
                variant="casino"
                size="lg"
                className="w-full"
                onClick={handleSpinDealer}
                disabled={spinning || players.length < 2}
              >
                <Dices className="w-4 h-4 mr-2" />
                {hasDealer ? "Re-spin Dealer" : "Spin for Dealer"}
              </Button>
            )}
            {isHost && players.length < 2 && (
              <p className="text-xs text-muted-foreground text-center mt-2">
                Need 2+ players to pick a dealer
              </p>
            )}
          </div>
        )}

        {/* Game selection + actions */}
        {lobby.status === "waiting" && isHost && (
          <div className="casino-card p-6 mb-6">
            <h2 className="font-serif text-lg font-semibold mb-4 flex items-center gap-2">
              <Crown className="w-4 h-4 text-gold-500" />
              Host Interface
            </h2>

            <div className="mb-4 flex items-center gap-3 p-3 rounded-xl border border-gold-500/30 bg-gold-500/5">
              <span className="text-3xl">{GAME_INFO[lobby.game_type].emoji}</span>
              <div className="min-w-0">
                <p className="font-display font-bold uppercase">{GAME_INFO[lobby.game_type].name}</p>
                <p className="text-xs text-muted-foreground">
                  {GAME_INFO[lobby.game_type].desc} · {GAME_INFO[lobby.game_type].limit}
                </p>
              </div>
            </div>

            <div className="mb-4">
              <Label className="mb-2 block">{isBankroll ? "Buy-in per player (starting bankroll)" : "Chips per player"}</Label>
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <Input
                  type="number"
                  min={1}
                  value={stakeInput}
                  onChange={(e) => setStakeInput(e.target.value)}
                  placeholder="100"
                  className="w-28"
                />
                {[100, 250, 500, 1000].map((amt) => (
                  <Button
                    key={amt}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setStakeInput(String(amt))}
                    className={
                      stakeInput === String(amt)
                        ? "text-gold-400 border border-gold-500/40 bg-gold-500/10"
                        : "text-muted-foreground"
                    }
                  >
                    {amt.toLocaleString()}
                  </Button>
                ))}
              </div>

              {/* Chip handout preview */}
              <div className="bg-muted/20 rounded-xl p-3 space-y-2">
                {players.map((lp) => {
                  const isDealer = hasDealer && lobby.dealer_id === lp.user_id;
                  return (
                    <div key={lp.id} className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 min-w-0">
                        <PlayerAvatar
                          username={lp.profile.username}
                          userId={lp.user_id}
                          size="sm"
                          isHost={lp.user_id === lobby.host_id}
                        />
                        <span className="truncate">
                          {lp.profile.username}
                          {lp.user_id === currentUser?.id && <span className="text-gold-400 ml-1">(you)</span>}
                        </span>
                      </span>
                      {isDealer && !isBankroll ? (
                        <span className="text-gold-400 font-semibold shrink-0 flex items-center gap-1">
                          👑 Banks the table
                        </span>
                      ) : (
                        <span className="text-gold-400 font-semibold shrink-0">
                          {isDealer && "👑 "}{Number(stakeInput) > 0 ? Number(stakeInput).toLocaleString() : "—"} chips
                        </span>
                      )}
                    </div>
                  );
                })}
                <div className="deco-divider">
                  <span className="text-[10px]">◆</span>
                </div>
                <div className="flex items-center justify-between text-sm font-semibold">
                  <span>{isBankroll ? "On the table" : hasDealer ? "On the table" : "Total pot"}</span>
                  <span className="text-gold-400">
                    {(Number(stakeInput) > 0
                      ? Number(stakeInput) * ((hasDealer && !isBankroll) ? players.length - 1 : players.length)
                      : 0
                    ).toLocaleString()} chips
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground text-right">
                  {lobby.game_type === "blackjack" || lobby.game_type === "free_bet"
                    ? "Multi-hand table — bet each hand from your bankroll; play until the dealer ends it or chips run out (rebuys allowed)"
                    : lobby.game_type === "texas_holdem"
                      ? "Real betting rounds — play hands until one player has every chip"
                      : lobby.game_type === "three_card"
                        ? "Ante each round vs the house — last player with chips standing wins"
                        : "Winner takes the pot minus the 5% rake"}
                </p>
              </div>
            </div>

            <Button
              variant="gold"
              size="lg"
              className="w-full"
              onClick={handleStartGame}
              disabled={starting || players.length < minPlayers}
            >
              {starting ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Starting...</>
              ) : (
                <><Play className="w-4 h-4 mr-2" /> Start Game</>
              )}
            </Button>
            {players.length < minPlayers && (
              <p className="text-xs text-muted-foreground text-center mt-2">
                Need at least {minPlayers} player{minPlayers > 1 ? "s" : ""} to start
              </p>
            )}

            <Button
              variant="outline"
              size="lg"
              className="w-full mt-3 border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={handleDisband}
              disabled={disbanding}
            >
              {disbanding ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Disbanding...</>
              ) : (
                <><Trash2 className="w-4 h-4 mr-2" /> Disband Lobby</>
              )}
            </Button>
          </div>
        )}

        {/* Join / Leave */}
        {lobby.status === "waiting" && (
        <div className="flex gap-3">
          {!isInLobby && !isFull && (
            <Button
              variant="gold"
              size="lg"
              className="flex-1"
              onClick={handleJoin}
              disabled={joining}
            >
              {joining ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Joining...</>
              ) : (
                <><DoorOpen className="w-4 h-4 mr-2" /> Join Lobby</>
              )}
            </Button>
          )}
          {isInLobby && (
            <Button variant="outline" size="lg" onClick={handleLeave} className="border-destructive/40 text-destructive hover:bg-destructive/10">
              Leave Lobby
            </Button>
          )}
        </div>
        )}
      </main>

      <Toaster />
    </>
  );
}
