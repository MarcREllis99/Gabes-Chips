# Gabe's Chips — Setup Guide

## Prerequisites

- Node.js 18+ (install via [nvm](https://github.com/nvm-sh/nvm) or [nodejs.org](https://nodejs.org))
- A [Supabase](https://supabase.com) account (free tier is fine)

---

## Step 1 — Install dependencies

```bash
npm install
```

---

## Step 2 — Create your Supabase project

1. Go to [supabase.com](https://supabase.com) → New project
2. Copy your **Project URL** and **anon public key** from Settings → API

Create `.env.local` in the project root:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

---

## Step 3 — Run the database schema

1. Go to Supabase Dashboard → SQL Editor
2. Paste and run the contents of `supabase-schema.sql`

---

## Step 4 — Enable Realtime

In Supabase Dashboard:
1. Go to **Database → Replication**
2. Enable realtime for these tables:
   - `lobby_players`
   - `games`
   - `lobbies`

---

## Step 5 — Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## How to play

1. **Sign up** — balances start at 0 and track net winnings/losses across games
2. **Create a lobby** — set a name and max player count (2–8); joining is free
3. **Share the 6-character code** with friends
4. **Host picks a game and a stake** (chips per player), then clicks Start — the stake is deducted from every player in the lobby
5. **Play!** — winner takes the pot minus the 5% house rake

---

## Games

### 🪙 Coin Flip (2 players)
- Host picks Heads or Tails; guest gets the other side
- The coin flips immediately with an animation
- Winner takes the pot (−5% rake)

### 🃏 Higher or Lower (2 players)
- 5 rounds
- A card is revealed; each player independently guesses if the next card is Higher or Lower
- Whoever guesses correctly wins the round (1 point)
- Player with most points at the end wins the pot (−5% rake)
- On a tie, Player 1 (host) wins

### 🂱 Blackjack (1–7 players vs the house dealer)
- Everyone plays against an automated dealer, not each other
- Each player gets 2 cards face up; the dealer gets one up, one hidden
- Hit or stand freely; bust (over 21) and you lose your stake
- When all players are done, the dealer reveals and must hit until 17+
- Beat the dealer's hand: win pays 1:1 · natural blackjack pays 3:2 · tie pushes (stake returned)
- No rake — the dealer's edge is the house take

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS + shadcn/ui |
| Database | Supabase (Postgres) |
| Auth | Supabase Auth |
| Realtime | Supabase Realtime |
| Fonts | Cinzel + Playfair Display (Google Fonts) |
