"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Navbar } from "@/components/navbar";
import { PlayerAvatar } from "@/components/player-avatar";
import { GAME_INFO, type GameType } from "@/lib/games";
import { Loader2, Trophy, History, Users } from "lucide-react";

interface LeaderRow {
  id: string;
  username: string;
  chip_balance: number;
  games_played: number;
  wins: number;
}

interface GameRow {
  game_id: string;
  game_type: string;
  stake: number;
  winner_username: string | null;
  player_count: number;
  created_at: string;
}

const MEDALS = ["🥇", "🥈", "🥉"];

function formatNet(amount: number): string {
  if (amount > 0) return `+${amount.toLocaleString()}`;
  return amount.toLocaleString();
}

function netClass(amount: number): string {
  if (amount > 0) return "text-green-400";
  if (amount < 0) return "text-red-400";
  return "text-muted-foreground";
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function gameMeta(gameType: string): { emoji: string; name: string } {
  const info = GAME_INFO[gameType as GameType];
  return info ? { emoji: info.emoji, name: info.name } : { emoji: "🎲", name: gameType };
}

export default function LeaderboardPage() {
  const [leaders, setLeaders] = useState<LeaderRow[]>([]);
  const [recent, setRecent] = useState<GameRow[]>([]);
  const [myId, setMyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const router = useRouter();
  const supabase = createClient();

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      router.push("/auth/login");
      return;
    }
    setMyId(user.id);

    const [leadersResult, recentResult] = await Promise.all([
      supabase.rpc("leaderboard_stats"),
      supabase.rpc("recent_games_feed", { p_limit: 15 }),
    ]);

    if (leadersResult.data) setLeaders(leadersResult.data as LeaderRow[]);
    if (recentResult.data) setRecent(recentResult.data as GameRow[]);
    setLoading(false);
  }, [router, supabase]);

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

  return (
    <>
      <Navbar />
      <main className="max-w-3xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="text-center mb-8 deco-sunburst py-4">
          <Trophy className="w-10 h-10 text-gold-400 mx-auto mb-3" />
          <h1 className="font-display text-4xl font-black logo-gold uppercase mb-3">
            Leaderboard
          </h1>
          <div className="deco-divider max-w-[260px] mx-auto mb-3">
            <span className="text-xs">◆</span>
          </div>
          <p className="text-muted-foreground text-sm tracking-wide">
            Net chips across every game — the house keeps score, you settle the rest.
          </p>
        </div>

        {/* Ledger */}
        <div className="casino-card p-4 sm:p-6 mb-8">
          {leaders.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No players yet — go win something.
            </p>
          ) : (
            <div className="divide-y divide-border/40">
              {leaders.map((row, i) => {
                const isMe = row.id === myId;
                return (
                  <div
                    key={row.id}
                    className={`flex items-center gap-3 py-3 px-2 rounded-lg ${isMe ? "bg-gold-500/5" : ""}`}
                  >
                    <span className="w-8 text-center shrink-0">
                      {i < 3 ? (
                        <span className="text-xl">{MEDALS[i]}</span>
                      ) : (
                        <span className="text-sm font-bold text-muted-foreground">{i + 1}</span>
                      )}
                    </span>
                    <PlayerAvatar username={row.username} userId={row.id} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-semibold truncate ${isMe ? "text-gold-400" : ""}`}>
                        {row.username}
                        {isMe && <span className="text-gold-400/70 ml-1 font-normal">(you)</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {row.games_played} game{row.games_played === 1 ? "" : "s"}
                        {row.wins > 0 && ` · ${row.wins} win${row.wins === 1 ? "" : "s"}`}
                      </p>
                    </div>
                    <span className={`font-mono text-base sm:text-lg font-bold shrink-0 ${netClass(row.chip_balance)}`}>
                      {formatNet(row.chip_balance)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent games */}
        <h2 className="font-serif text-xl font-semibold text-muted-foreground mb-4 flex items-center gap-2">
          <History className="w-4 h-4" />
          Recent Games
        </h2>
        <div className="casino-card p-4 sm:p-6">
          {recent.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No finished games yet.
            </p>
          ) : (
            <div className="divide-y divide-border/40">
              {recent.map((g) => {
                const meta = gameMeta(g.game_type);
                return (
                  <div key={g.game_id} className="flex items-center gap-3 py-3 px-2">
                    <span className="text-2xl shrink-0">{meta.emoji}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate">
                        {meta.name}
                        <span className="text-muted-foreground font-normal">
                          {" · "}{g.stake.toLocaleString()} chips each
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground flex items-center gap-2">
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          {g.player_count}
                        </span>
                        <span>·</span>
                        <span>{timeAgo(g.created_at)}</span>
                      </p>
                    </div>
                    <span className="text-sm shrink-0 text-right">
                      {g.winner_username ? (
                        <>
                          <Trophy className="w-3.5 h-3.5 text-gold-400 inline mr-1" />
                          <span className="text-gold-400 font-semibold">{g.winner_username}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">vs the house</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
