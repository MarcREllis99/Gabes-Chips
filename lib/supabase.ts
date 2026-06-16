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
          status: "waiting" | "active" | "finished" | "tracking";
          max_players: number;
          buy_in: number;
          game_type: "coin_flip" | "higher_lower" | "blackjack" | "texas_holdem" | "three_card" | "free_bet" | "euchre" | "gabes_wilds" | "war" | "chip_tracker";
          dealer_id: string | null;
          carry_pot: number;
          tracker_config: Record<string, unknown> | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          code: string;
          host_id: string;
          status?: "waiting" | "active" | "finished" | "tracking";
          max_players: number;
          buy_in: number;
          game_type?: "coin_flip" | "higher_lower" | "blackjack" | "texas_holdem" | "three_card" | "free_bet" | "euchre" | "gabes_wilds" | "war" | "chip_tracker";
          dealer_id?: string | null;
          tracker_config?: Record<string, unknown> | null;
          created_at?: string;
        };
        Update: {
          name?: string;
          status?: "waiting" | "active" | "finished" | "tracking";
          game_type?: "coin_flip" | "higher_lower" | "blackjack" | "texas_holdem" | "three_card" | "free_bet" | "euchre" | "gabes_wilds" | "war" | "chip_tracker";
          dealer_id?: string | null;
        };
      };
      lobby_players: {
        Row: {
          id: string;
          lobby_id: string;
          user_id: string;
          chips: number;
          joined_at: string;
        };
        Insert: {
          id?: string;
          lobby_id: string;
          user_id: string;
          chips?: number;
          joined_at?: string;
        };
        Update: { chips?: number };
      };
      games: {
        Row: {
          id: string;
          lobby_id: string;
          game_type: "coin_flip" | "higher_lower" | "blackjack" | "texas_holdem" | "three_card" | "free_bet" | "euchre" | "gabes_wilds" | "war" | "chip_tracker";
          state: Record<string, unknown>;
          winner_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          lobby_id: string;
          game_type: "coin_flip" | "higher_lower" | "blackjack" | "texas_holdem" | "three_card" | "free_bet" | "euchre" | "gabes_wilds" | "war" | "chip_tracker";
          state?: Record<string, unknown>;
          winner_id?: string | null;
          created_at?: string;
        };
        Update: {
          state?: Record<string, unknown>;
          winner_id?: string | null;
        };
      };
      chip_transfers: {
        Row: {
          id: string;
          lobby_id: string;
          from_user: string;
          to_user: string;
          amount: number;
          created_at: string;
        };
        Insert: {
          lobby_id: string;
          from_user: string;
          to_user: string;
          amount: number;
        };
        Update: Record<string, never>;
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