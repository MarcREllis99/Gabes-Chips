"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Navbar } from "@/components/navbar";
import { CoinFlipGame } from "@/components/game/coin-flip-game";
import { HigherLowerGame } from "@/components/game/higher-lower-game";
import { BlackjackGame } from "@/components/game/blackjack-game";
import { TexasHoldemGame } from "@/components/game/texas-holdem-game";
import { ThreeCardGame } from "@/components/game/three-card-game";
import { FreeBetGame } from "@/components/game/free-bet-game";
import { EuchreGame } from "@/components/game/euchre-game";
import { GabesWildsGame } from "@/components/game/gabes-wilds-game";
import { GAME_INFO, type GameType } from "@/lib/games";
import { Loader2, LogOut } from "lucide-react";
import type { Database } from "@/lib/supabase";

type Lobby = Database["public"]["Tables"]["lobbies"]["Row"];
type Game = Database["public"]["Tables"]["games"]["Row"];
type Profile = Database["public"]["Tables"]["profiles"]["Row"];

const GAME_COMPONENTS = {
  coin_flip: CoinFlipGame,
  higher_lower: HigherLowerGame,
  blackjack: BlackjackGame,
  texas_holdem: TexasHoldemGame,
  three_card: ThreeCardGame,
  free_bet: FreeBetGame,
  euchre: EuchreGame,
  gabes_wilds: GabesWildsGame,
} as const;

export default function GamePage() {
  const params = useParams();
  const code = (params.code as string).toUpperCase();

  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [players, setPlayers] = useState<Profile[]>([]);
  const [currentUser, setCurrentUser] = useState<{ id: string } | null>(null);
  const [currentProfile, setCurrentProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [leaving, setLeaving] = useState(false);

  const router = useRouter();
  const supabase = createClient();
  const gameIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.push("/auth/login"); return; }
    setCurrentUser(user);

    const [profileResult, lobbyResult] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", user.id).single(),
      supabase.from("lobbies").select("*").eq("code", code).single(),
    ]);

    setCurrentProfile(profileResult.data);

    if (!lobbyResult.data) { router.push("/"); return; }
    const lobby = lobbyResult.data;
    setLobby(lobby);

    const [gameResult, lpResult] = await Promise.all([
      supabase.from("games").select("*").eq("lobby_id", lobby.id).order("created_at", { ascending: false }).limit(1).single(),
      supabase.from("lobby_players").select("user_id").eq("lobby_id", lobby.id),
    ]);

    setGame(gameResult.data);
    gameIdRef.current = gameResult.data?.id ?? null;

    if (lpResult.data) {
      const profileResults = await Promise.all(
        lpResult.data.map((lp) =>
          supabase.from("profiles").select("*").eq("id", lp.user_id).single()
        )
      );
      setPlayers(profileResults.map((r) => r.data!).filter(Boolean));
    }

    setLoading(false);
  }, [code, router, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep this screen in step with continuation: when the host resets the
  // lobby (status → waiting) head back to the waiting room; when a brand-new
  // game is dealt for this lobby, swap into it.
  useEffect(() => {
    if (!lobby) return;
    const channel = supabase
      .channel(`gamepage-${lobby.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "lobbies", filter: `id=eq.${lobby.id}` },
        (payload) => {
          if ((payload.new as Lobby).status === "waiting") {
            router.push(`/lobby/${code}`);
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "games", filter: `lobby_id=eq.${lobby.id}` },
        (payload) => {
          const newId = (payload.new as Game).id;
          if (newId && newId !== gameIdRef.current) load();
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [lobby, supabase, router, code, load]);

  const handleLeave = async () => {
    if (!window.confirm("Leave this game? You forfeit your stake in the current hand. You'll go back to the game menu.")) return;
    setLeaving(true);
    router.push("/");
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gold-400" />
      </div>
    );
  }

  if (!lobby || !game || !currentUser || !currentProfile) return null;

  const isHost = lobby.host_id === currentUser.id;
  const stake = ((game.state as Record<string, unknown> | null)?.stake as number) ?? 0;
  const pot = stake * players.length;

  const GameComponent = GAME_COMPONENTS[game.game_type as GameType];

  return (
    <>
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-4 pb-safe">
        {/* In-game toolbar: leave for another game */}
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm text-muted-foreground truncate">
            {GAME_INFO[game.game_type as GameType]?.emoji} {lobby.name}
          </span>
          <button
            onClick={handleLeave}
            disabled={leaving}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive transition-colors"
            title="Leave for another game"
          >
            <LogOut className="w-3.5 h-3.5" />
            Leave
          </button>
        </div>

        {GameComponent && (
          <GameComponent
            key={game.id}
            game={game}
            lobby={lobby}
            players={players}
            currentUser={currentUser}
            currentProfile={currentProfile}
            isHost={isHost}
            pot={pot}
            onGameEnd={() => router.push(`/lobby/${code}`)}
          />
        )}
      </main>
    </>
  );
}
