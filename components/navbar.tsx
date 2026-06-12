"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Button } from "./ui/button";
import { LogOut, Trophy } from "lucide-react";
import type { Database } from "@/lib/supabase";

type Profile = Database["public"]["Tables"]["profiles"]["Row"];

export function Navbar() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .single();
      setProfile(data);
    };
    load();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => load());
    return () => subscription.unsubscribe();
  }, []);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push("/auth/login");
    router.refresh();
  };

  return (
    <nav className="sticky top-0 z-40 deco-nav bg-background/85 backdrop-blur-md pt-safe">
      <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 group">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="Gabe's Chips"
            className="w-9 h-9 object-contain transition-transform group-hover:scale-105"
          />
          <span className="font-display text-xl font-bold logo-gold hidden sm:block uppercase">
            Gabe&apos;s Chips
          </span>
        </Link>

        {profile && (
          <div className="flex items-center gap-3">
            <Link
              href="/leaderboard"
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-gold-400 transition-colors"
              title="Leaderboard"
            >
              <Trophy className="w-4 h-4" />
              <span className="hidden sm:inline">Leaderboard</span>
            </Link>
            <span className="text-sm text-muted-foreground hidden sm:block">
              {profile.username}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleSignOut}
              className="text-muted-foreground hover:text-foreground"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>
    </nav>
  );
}
