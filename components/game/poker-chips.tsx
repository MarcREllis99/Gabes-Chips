// Interactive denomination chips shared by the in-game poker tables
// (Texas Hold'em, 3 Card Poker). Stacks are whole-chip integers; the
// denomination set is derived from the buy-in. $1 is always included so any
// integer amount renders exactly.

const STD = [1, 5, 25, 100, 500, 1000, 5000, 25000];

// A sensible standard chip set scaled to the buy-in (always includes $1).
export function denomsForBuyIn(buyIn: number): number[] {
  const cap = Math.max(1, Math.floor((buyIn || 0) / 2));
  let topIdx = 0;
  for (let i = 0; i < STD.length; i++) if (STD[i] <= cap) topIdx = i;
  const lo = Math.max(0, topIdx - 3);
  const set = STD.slice(lo, topIdx + 1);
  if (!set.includes(1)) set.unshift(1);
  return set;
}

// Greedy breakdown of a whole-chip amount into denominations (desc).
export function chipBreakdown(amount: number, denoms: number[]): [number, number][] {
  const out: [number, number][] = [];
  let rem = Math.max(0, Math.floor(amount));
  for (const d of [...denoms].sort((a, b) => b - a)) {
    const n = Math.floor(rem / d);
    if (n > 0) { out.push([d, n]); rem -= n * d; }
  }
  return out;
}

const CHIP_COLORS: Record<number, { bg: string; ring: string; text: string }> = {
  1: { bg: "#e5e7eb", ring: "#94a3b8", text: "#111827" },     // white
  5: { bg: "#dc2626", ring: "#7f1d1d", text: "#ffffff" },     // red
  25: { bg: "#16a34a", ring: "#14532d", text: "#ffffff" },    // green
  100: { bg: "#111827", ring: "#000000", text: "#fbbf24" },   // black
  500: { bg: "#7c3aed", ring: "#4c1d95", text: "#ffffff" },   // purple
  1000: { bg: "#b45309", ring: "#78350f", text: "#fde68a" },  // brass
  5000: { bg: "#be185d", ring: "#831843", text: "#ffffff" },  // magenta
  25000: { bg: "#0e7490", ring: "#155e75", text: "#ffffff" }, // teal
};
function chipStyle(v: number) {
  if (CHIP_COLORS[v]) return CHIP_COLORS[v];
  if (v < 5) return CHIP_COLORS[1];
  if (v < 25) return CHIP_COLORS[5];
  if (v < 100) return CHIP_COLORS[25];
  if (v < 500) return CHIP_COLORS[100];
  if (v < 1000) return CHIP_COLORS[500];
  return CHIP_COLORS[1000];
}
function chipLabel(v: number) {
  return v >= 1000 ? `$${v % 1000 === 0 ? v / 1000 : (v / 1000).toFixed(1)}K` : `$${v}`;
}

export function Chip({ value, size = 30 }: { value: number; size?: number }) {
  const s = chipStyle(value);
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className="shrink-0">
      <circle cx="20" cy="20" r="19" fill={s.bg} />
      <circle cx="20" cy="20" r="15.5" fill="none" stroke={s.ring} strokeWidth="5" strokeDasharray="5.2 6.95" />
      <circle cx="20" cy="20" r="11" fill={s.bg} stroke={s.ring} strokeWidth="1" />
      <text x="20" y="24" textAnchor="middle" fontSize="9" fontWeight="bold" fill={s.text}>{chipLabel(value)}</text>
    </svg>
  );
}

// Read-only rendering of an amount as a stack of denomination chips.
export function ChipStack({ amount, denoms, size = 20 }: { amount: number; denoms: number[]; size?: number }) {
  const bd = chipBreakdown(amount, denoms);
  if (amount <= 0) return <span className="text-[10px] text-white/40">no chips</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {bd.map(([d, c]) => (
        <span key={d} className="flex items-center">
          <Chip value={d} size={size} />
          {c > 1 && <span className="text-[10px] text-white/70 ml-0.5">×{c}</span>}
        </span>
      ))}
    </span>
  );
}
