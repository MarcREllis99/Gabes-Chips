import { cn } from "@/lib/utils";

const SUIT_COLORS: Record<string, string> = {
  "♠": "text-[#232633]",
  "♣": "text-[#232633]",
  "♥": "text-[#a8243a]",
  "♦": "text-[#a8243a]",
};

// Sizes scale up at the `sm` breakpoint so cards stay compact on phones
// (where most play happens) and fill out on larger screens.
const SIZES = {
  sm: { card: "w-10 h-[3.5rem] sm:w-12 sm:h-[4.25rem]", corner: "text-[10px] sm:text-[11px]", cornerSuit: "text-[8px] sm:text-[9px]", pip: "text-lg sm:text-xl", pad: "p-1" },
  md: { card: "w-16 h-24 sm:w-20 sm:h-28", corner: "text-sm sm:text-base", cornerSuit: "text-[10px] sm:text-xs", pip: "text-3xl sm:text-4xl", pad: "p-1.5" },
  lg: { card: "w-24 h-36 sm:w-32 sm:h-44", corner: "text-xl sm:text-2xl", cornerSuit: "text-sm sm:text-base", pip: "text-5xl sm:text-6xl", pad: "p-2 sm:p-2.5" },
} as const;

interface PlayingCardProps {
  rank: string;
  suit: string;
  size?: keyof typeof SIZES;
  faceDown?: boolean;
  highlight?: boolean;
}

export function PlayingCard({
  rank,
  suit,
  size = "md",
  faceDown = false,
  highlight = false,
}: PlayingCardProps) {
  const s = SIZES[size];

  if (faceDown) {
    return (
      <div className={cn("deco-card-back flex items-center justify-center", s.card)}>
        <div className="w-1/3 aspect-square rotate-45 border border-gold-500/50 flex items-center justify-center">
          <span className="-rotate-45 text-gold-500/70 text-lg leading-none">◆</span>
        </div>
      </div>
    );
  }

  const color = SUIT_COLORS[suit] ?? "text-[#232633]";

  return (
    <div className={cn("deco-card flex flex-col justify-between", s.card, s.pad, highlight && "deco-card-highlight")}>
      <div className={cn("self-start font-serif font-bold leading-none", color, s.corner)}>
        <div>{rank}</div>
        <div className={s.cornerSuit}>{suit}</div>
      </div>
      <div className={cn("text-center leading-none", color, s.pip)}>{suit}</div>
      <div className={cn("self-end rotate-180 font-serif font-bold leading-none", color, s.corner)}>
        <div>{rank}</div>
        <div className={s.cornerSuit}>{suit}</div>
      </div>
    </div>
  );
}
