-- ============================================================
-- Chip Tracker: optional physical chip-denomination config (Poker).
-- Stores how the buy-in breaks down into physical chips so everyone at
-- the table sets up the same stacks. Purely a reference; the tracker's
-- send/receive still works in whole chips.
-- ============================================================

alter table public.lobbies
  add column if not exists tracker_config jsonb;
