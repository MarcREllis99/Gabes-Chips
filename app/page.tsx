"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { generateLobbyCode } from "@/lib/utils";
import { GAME_INFO, GAME_LIST, type GameType } from "@/lib/games";
import { Navbar } from "@/components/navbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/components/ui/use-toast";
import {
  Users, Loader2,
  Search, RefreshCw, DoorOpen, Wifi,
} from "lucide-react";
import type { Database } from "@/lib/supabase";

type Lobby = Database["public"]["Tables"]["lobbies"]["Row"] & {
  player_count?: number;
  host_username?: string;
  on_my_network?: boolean;
};

export default function HomePage() {
  const [user, setUser] = useState<{ id: string } | null>(null);
  const [lobbies, setLobbies] = useState<Lobby[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinLoading, setJoinLoading] = useState(false);

  // Create lobby form
  const [selectedGame, setSelectedGame] = useState<GameType | null>(null);
  const [lobbyName, setLobbyName] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [createLoading, setCreateLoading] = useState(false);

  // Chip Tracker
  const [showTracker, setShowTracker] = useState(false);
  const [trackerGame, setTrackerGame] = useState("Poker");
  const [trackerBuyIn, setTrackerBuyIn] = useState("500");
  const [trackerLoading, setTrackerLoading] = useState(false);

  const router = useRouter();
  const supabase = createClient();
  const { toast } = useToast();

  const loadData = useCallback(async () => {
    const { data: { user: authUser } } = await supabase.auth.getUser();
    if (!authUser) {
      router.push("/auth/login");
      return;
    }
    setUser(authUser);

    // One call returns lobbies + player counts + host names + the
    // server-computed "same public IP as me" flag.
    const { data: lobbyRows } = await supabase.rpc("open_lobbies_with_network");
    if (lobbyRows) {
      setLobbies(lobbyRows as unknown as Lobby[]);
    }
    setLoading(false);
  }, [router, supabase]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const openCreateFor = (gameId: GameType) => {
    const info = GAME_INFO[gameId];
    setSelectedGame(gameId);
    // Fixed-count games lock to their required size; ranged games default to 4.
    setMaxPlayers(
      info.minPlayers === info.maxPlayers
        ? info.maxPlayers
        : info.maxPlayers > 2
          ? 4
          : 2
    );
    setShowCreate(true);
  };

  const handleCreateLobby = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !selectedGame) return;

    setCreateLoading(true);
    const code = generateLobbyCode();

    const { data: lobby, error } = await supabase
      .from("lobbies")
      .insert({
        name: lobbyName,
        code,
        host_id: user.id,
        max_players: maxPlayers,
        buy_in: 0,
        status: "waiting",
        game_type: selectedGame,
      })
      .select()
      .single();

    if (error || !lobby) {
      toast({ title: "Failed to create lobby", description: error?.message, variant: "destructive" });
      setCreateLoading(false);
      return;
    }

    await supabase.from("lobby_players").insert({ lobby_id: lobby.id, user_id: user.id });

    setCreateLoading(false);
    setShowCreate(false);
    router.push(`/lobby/${code}`);
  };

  const handleCreateTracker = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !trackerGame.trim()) return;
    setTrackerLoading(true);
    const code = generateLobbyCode();

    const { data: lobby, error } = await supabase
      .from("lobbies")
      .insert({
        name: `${trackerGame.trim()} — Chip Tracker`,
        code,
        host_id: user.id,
        max_players: 8,
        buy_in: Math.max(0, Number(trackerBuyIn) || 0),
        status: "tracking",
        game_type: "chip_tracker",
      })
      .select()
      .single();

    if (error || !lobby) {
      toast({ title: "Couldn't start the tracker", description: error?.message, variant: "destructive" });
      setTrackerLoading(false);
      return;
    }

    await supabase.from("lobby_players").insert({ lobby_id: lobby.id, user_id: user.id });

    setTrackerLoading(false);
    setShowTracker(false);
    router.push(`/lobby/${code}`);
  };

  const handleJoinByCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCode.trim()) return;
    setJoinLoading(true);

    // Find the room by code regardless of status (covers Chip Tracker rooms too)
    const { data: lobby } = await supabase
      .from("lobbies")
      .select("*")
      .eq("code", joinCode.toUpperCase().trim())
      .in("status", ["waiting", "tracking"])
      .single();

    if (!lobby) {
      toast({ title: "Room not found", description: "Check the code and try again.", variant: "destructive" });
      setJoinLoading(false);
      return;
    }

    setJoinLoading(false);
    router.push(`/lobby/${lobby.code}`);
  };

  const handleJoinLobby = (code: string) => {
    router.push(`/lobby/${code}`);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gold-400" />
      </div>
    );
  }

  const localLobbies = lobbies.filter((l) => l.on_my_network);
  const otherLobbies = lobbies.filter((l) => !l.on_my_network);

  return (
    <>
      <Navbar />
      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Hero */}
        <div className="text-center mb-10 py-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="Gabe's Chips"
            className="w-28 h-28 sm:w-36 sm:h-36 object-contain mx-auto mb-4"
          />
          <div className="deco-divider max-w-xs mx-auto mb-5">
            <span className="text-sm">◆ ◆ ◆</span>
          </div>
          <h1 className="font-display text-5xl sm:text-6xl font-black logo-gold mb-3 uppercase">
            Gabe&apos;s Chips
          </h1>
          <div className="deco-divider max-w-md mx-auto mb-5">
            <span className="text-xl">♠</span>
          </div>
          <p className="text-muted-foreground text-lg tracking-wide">
            Anywhere you are.
          </p>
        </div>

        {/* Chip Tracker */}
        <div className="mb-8">
          <div className="deco-divider max-w-sm mx-auto mb-4">
            <span className="font-serif text-sm text-muted-foreground tracking-widest uppercase px-2">Chip Tracker</span>
          </div>
          <button
            type="button"
            onClick={() => setShowTracker(true)}
            className="casino-card w-full p-5 flex items-center gap-4 text-left hover:border-gold-500/50 transition-all duration-200 group"
          >
            <div className="text-3xl shrink-0">🪙</div>
            <div className="min-w-0 flex-1">
              <div className="font-display text-lg font-bold uppercase group-hover:text-gold-400 transition-colors">
                Track Chips for Your Own Game
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">
                Playing with real cards? Keep score here — send &amp; receive chips with friends.
              </p>
            </div>
            <span className="text-gold-400 shrink-0 text-sm font-semibold hidden sm:block">Start →</span>
          </button>
        </div>

        {/* Game menu */}
        <div className="mb-8">
          <div className="deco-divider max-w-sm mx-auto mb-4">
            <span className="font-serif text-sm text-muted-foreground tracking-widest uppercase px-2">Choose Your Game</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {GAME_LIST.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => openCreateFor(g.id)}
                className="casino-card p-5 text-left hover:border-gold-500/50 hover:-translate-y-0.5 transition-all duration-200 group"
              >
                <div className="text-4xl mb-2">{g.emoji}</div>
                <div className="font-display text-lg font-bold uppercase group-hover:text-gold-400 transition-colors">
                  {g.name}
                </div>
                <p className="text-sm text-muted-foreground mt-1">{g.desc}</p>
                <span className="inline-flex items-center gap-1.5 mt-3 text-xs text-gold-400 border border-gold-600/40 rounded-full px-2.5 py-1">
                  <Users className="w-3 h-3" />
                  {g.limit}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Join by code */}
        <div className="flex justify-center gap-2 mb-8">
          <form onSubmit={handleJoinByCode} className="flex gap-2 w-full sm:w-auto">
            <Input
              placeholder="Have a code? (e.g. XK92TF)"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              maxLength={6}
              className="flex-1 sm:flex-none font-mono tracking-widest uppercase placeholder:normal-case placeholder:tracking-normal sm:w-64"
            />
            <Button variant="casino" type="submit" disabled={joinLoading || joinCode.length !== 6}>
              {joinLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <DoorOpen className="w-4 h-4" />}
            </Button>
          </form>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => { setLoading(true); loadData(); }}
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>

        {/* On your WiFi */}
        {localLobbies.length > 0 && (
          <div className="mb-8">
            <h2 className="font-serif text-xl font-semibold text-gold-400 mb-4 flex items-center gap-2">
              <Wifi className="w-4 h-4" />
              On Your WiFi
              <span className="text-xs bg-gold-500/15 border border-gold-500/40 px-2 py-0.5 rounded-full">{localLobbies.length}</span>
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {localLobbies.map((lobby) => (
                <LobbyCard
                  key={lobby.id}
                  lobby={lobby}
                  local
                  isOwn={lobby.host_id === user?.id}
                  onJoin={() => handleJoinLobby(lobby.code)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Lobby list */}
        <div>
          <h2 className="font-serif text-xl font-semibold text-muted-foreground mb-4 flex items-center gap-2">
            <Search className="w-4 h-4" />
            Open Lobbies
            <span className="text-xs bg-muted px-2 py-0.5 rounded-full">{otherLobbies.length}</span>
          </h2>

          {otherLobbies.length === 0 ? (
            <div className="casino-card p-12 text-center">
              <p className="text-muted-foreground mb-2">
                {localLobbies.length > 0 ? "No other open lobbies right now." : "No open lobbies right now."}
              </p>
              <p className="text-sm text-muted-foreground">
                Be the first — create one and invite your friends!
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {otherLobbies.map((lobby) => (
                <LobbyCard
                  key={lobby.id}
                  lobby={lobby}
                  isOwn={lobby.host_id === user?.id}
                  onJoin={() => handleJoinLobby(lobby.code)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Create lobby modal */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl gold-gradient">
              {selectedGame ? `${GAME_INFO[selectedGame].emoji} ${GAME_INFO[selectedGame].name} — Create Lobby` : "Create Lobby"}
            </DialogTitle>
            <DialogDescription>
              {selectedGame ? GAME_INFO[selectedGame].desc : "Set up a private room."}{" "}
              Share the code with friends to join.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreateLobby} className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label>Lobby Name</Label>
              <Input
                placeholder="Friday Night Games"
                value={lobbyName}
                onChange={(e) => setLobbyName(e.target.value)}
                required
                maxLength={40}
              />
            </div>

            <div className="space-y-2">
              <Label>Max Players</Label>
              {selectedGame && GAME_INFO[selectedGame].minPlayers === GAME_INFO[selectedGame].maxPlayers ? (
                <p className="text-sm text-muted-foreground py-1.5">
                  {GAME_INFO[selectedGame].maxPlayers} players — {GAME_INFO[selectedGame].maxPlayers === 4 ? "2 teams" : "head-to-head"} (fixed)
                </p>
              ) : selectedGame && GAME_INFO[selectedGame].maxPlayers > 2 ? (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setMaxPlayers(Math.max(2, maxPlayers - 1))}
                  >-</Button>
                  <span className="w-8 text-center font-bold">{maxPlayers}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setMaxPlayers(Math.min(GAME_INFO[selectedGame].maxPlayers, maxPlayers + 1))}
                  >+</Button>
                  <span className="text-xs text-muted-foreground ml-1">up to {GAME_INFO[selectedGame].maxPlayers}</span>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-1.5">
                  2 players — head-to-head
                </p>
              )}
            </div>

            <div className="bg-muted/50 rounded-lg p-3 text-sm text-muted-foreground">
              <p>
                Joining is free — you&apos;ll set the <strong className="text-gold-400">chips per player</strong> when you start a game.
              </p>
            </div>

            <Button
              type="submit"
              variant="gold"
              size="lg"
              className="w-full"
              disabled={createLoading || !lobbyName}
            >
              {createLoading ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating...</>
              ) : (
                "Create Lobby"
              )}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* Chip Tracker modal */}
      <Dialog open={showTracker} onOpenChange={setShowTracker}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl logo-gold">Chip Tracker</DialogTitle>
            <DialogDescription>
              What are you playing? We&apos;ll set up a room so you can send &amp; receive chips
              while you play with your own cards.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreateTracker} className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label>Game</Label>
              <div className="flex flex-wrap gap-2">
                {["Poker", "Blackjack", "Euchre", "Rummy", "Hearts", "Spades"].map((g) => (
                  <Button
                    key={g}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setTrackerGame(g)}
                    className={trackerGame === g ? "text-gold-400 border border-gold-500/40 bg-gold-500/10" : "text-muted-foreground"}
                  >
                    {g}
                  </Button>
                ))}
              </div>
              <Input
                placeholder="Or type a game…"
                value={trackerGame}
                onChange={(e) => setTrackerGame(e.target.value)}
                maxLength={30}
                required
              />
            </div>

            <div className="space-y-2">
              <Label>Starting chips (each player&apos;s buy-in)</Label>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={trackerBuyIn}
                onChange={(e) => setTrackerBuyIn(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Just a reference for how many chips you&apos;re each playing with. Chips move only when you
                send them — balances are your real running total.
              </p>
            </div>

            <Button type="submit" variant="gold" size="lg" className="w-full" disabled={trackerLoading || !trackerGame.trim()}>
              {trackerLoading ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Setting up…</>
              ) : (
                "Start Tracking"
              )}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Toaster />
    </>
  );
}

function LobbyCard({
  lobby,
  isOwn,
  onJoin,
  local = false,
}: {
  lobby: Lobby;
  isOwn: boolean;
  onJoin: () => void;
  local?: boolean;
}) {
  const isFull = (lobby.player_count ?? 0) >= lobby.max_players;

  return (
    <div className={`casino-card p-5 transition-all duration-200 group ${local ? "border-gold-500/40 hover:border-gold-500/70" : "hover:border-gold-600/30"}`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-serif font-semibold text-lg group-hover:text-gold-400 transition-colors">
            {lobby.name}
          </h3>
          <p className="text-xs text-muted-foreground">by {lobby.host_username}</p>
        </div>
        <span className="lobby-code text-sm px-2 py-1 text-sm">{lobby.code}</span>
      </div>

      <div className="flex items-center gap-4 mb-4 text-sm text-muted-foreground">
        <span className="flex items-center gap-1">
          <Users className="w-3.5 h-3.5" />
          {lobby.player_count}/{lobby.max_players}
        </span>
        <span>
          {GAME_INFO[lobby.game_type].emoji} {GAME_INFO[lobby.game_type].name}
        </span>
        {local && (
          <span className="flex items-center gap-1 text-gold-400">
            <Wifi className="w-3.5 h-3.5" />
            Your WiFi
          </span>
        )}
      </div>

      <Button
        variant={isOwn ? "casino" : "gold"}
        size="sm"
        className="w-full"
        onClick={onJoin}
        disabled={!isOwn && isFull}
      >
        {isOwn ? "View Lobby" : isFull ? "Full" : "Join"}
      </Button>
    </div>
  );
}
