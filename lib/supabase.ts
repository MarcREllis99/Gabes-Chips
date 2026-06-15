import { createBrowserClient } from "@supabase/ssr";

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          username: string;
          chip_balance: number;
          created_at: string;
        };
        Insert: {
          id: string;
          username: string;
          chip_balance?: number;
          created_at?: string;
        };
        Update: {
          username?: string;
          chip_balance?: number;
        };
      };
      lobbies: {
        Row: {
          id: string;
          name: string;
          code: string;
          host_id: string;
          status: "waiting" | "active" | "finished";
          max_players: number;
          buy_in: number;
          game_type: "coin_flip" | "higher_lower" | "blackjack" | "texas_holdem" | "three_card" | "free_bet" | "euchre" | "gabes_wilds" | "war";
          dealer_id: string | null;
          carry_pot: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          code: string;
          host_id: string;
          status?: "waiting" | "active" | "finished";
          max_players: number;
          buy_in: number;
          game_type?: "coin_flip" | "higher_lower" | "blackjack" | "texas_holdem" | "three_card" | "free_bet" | "euchre" | "gabes_wilds" | "war";
          dealer_id?: string | null;
          created_at?: string;
        };
        Update: {
          name?: string;
          status?: "waiting" | "active" | "finished";
          game_type?: "coin_flip" | "higher_lower" | "blackjack" | "texas_holdem" | "three_card" | "free_bet" | "euchre" | "gabes_wilds" | "war";
          dealer_id?: string | null;
        };
      };
      lobby_players: {
        Row: {
          id: string;
          lobby_id: string;
          user_id: string;
          joined_at: string;
        };
        Insert: {
          id?: string;
          lobby_id: string;
          user_id: string;
          joined_at?: string;
        };
        Update: Record<string, never>;
      };
      games: {
        Row: {
          id: string;
          lobby_id: string;
          game_type: "coin_flip" | "higher_lower" | "blackjack" | "texas_holdem" | "three_card" | "free_bet" | "euchre" | "gabes_wilds" | "war";
          state: Record<string, unknown>;
          winner_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          lobby_id: string;
          game_type: "coin_flip" | "higher_lower" | "blackjack" | "texas_holdem" | "three_card" | "free_bet" | "euchre" | "gabes_wilds" | "war";
          state?: Record<string, unknown>;
          winner_id?: string | null;
          created_at?: string;
        };
        Update: {
          state?: Record<string, unknown>;
          winner_id?: string | null;
        };
      };
    };
  };
};

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}