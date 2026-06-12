"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Navbar } from "@/components/navbar";
import { CoinFlipGame } from "@/components/game/coin-flip-game";
import { HigherLowerGame } from "@/components/game/higher-lower-game";
import { BlackjackGame } from "@/components/game/blackjack-game";
import { TexasHoldemGame } from "@/components/game/texas-holdem-game";
import { ThreeCardGame } from "@/components/game/three-card-game";
import { FreeBetGame } from "@/components/game/free-bet-game";
import { Loader2 } from "lucide-react";
import type { Database } from "@/lib/supabase";

type Lobby = Database["public"]["Tables"]["lobbies"]["Row"];
type Game = Database["public"]["Tables"]["games"]["Row"];
type Profile = Database["public"]["Tables"]["profiles"]["Row"];

export default function GamePage() {
  const params = useParams();
  const code = (params.code as string).toUpperCase();

  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [players, setPlayers] = useState<Profile[]>([]);
  const [currentUser, setCurrentUser] = useState<{ id: string } | null>(null);
  const [currentProfile, setCurrentProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const router = useRouter();
  const supabase = createClient();

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

  return (
    <>
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6">
        {game.game_type === "coin_flip" && (
          <CoinFlipGame
            game={game}
            lobby={lobby}
            players={players}
            currentUser={currentUser}
            currentProfile={currentProfile}
            isHost={isHost}
            pot={pot}
            onGameEnd={() => router.push("/")}
          />
        )}
        {game.game_type === "higher_lower" && (
          <HigherLowerGame
            game={game}
            lobby={lobby}
            players={players}
            currentUser={currentUser}
            currentProfile={currentProfile}
            isHost={isHost}
            pot={pot}
            onGameEnd={() => router.push("/")}
          />
        )}
        {game.game_type === "blackjack" && (
          <BlackjackGame
            game={game}
            lobby={lobby}
            players={players}
            currentUser={currentUser}
            currentProfile={currentProfile}
            isHost={isHost}
            pot={pot}
            onGameEnd={() => router.push("/")}
          />
        )}
        {game.game_type === "texas_holdem" && (
          <TexasHoldemGame
            game={game}
            lobby={lobby}
            players={players}
            currentUser={currentUser}
            currentProfile={currentProfile}
            isHost={isHost}
            pot={pot}
            onGameEnd={() => router.push("/")}
          />
        )}
        {game.game_type === "three_card" && (
          <ThreeCardGame
            game={game}
            lobby={lobby}
            players={players}
            currentUser={currentUser}
            currentProfile={currentProfile}
            isHost={isHost}
            pot={pot}
            onGameEnd={() => router.push("/")}
          />
        )}
        {game.game_type === "free_bet" && (
          <FreeBetGame
            game={game}
            lobby={lobby}
            players={players}
            currentUser={currentUser}
            currentProfile={currentProfile}
            isHost={isHost}
            pot={pot}
            onGameEnd={() => router.push("/")}
          />
        )}
      </main>
    </>
  );
}