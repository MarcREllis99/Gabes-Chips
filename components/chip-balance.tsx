"use client";

import { Coins } from "lucide-react";
import { formatChips } from "@/lib/utils";

interface ChipBalanceProps {
  balance: number;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function ChipBalance({ balance, size = "md", className = "" }: ChipBalanceProps) {
  const sizeClasses = {
    sm: "text-xs px-2 py-0.5 gap-1",
    md: "text-sm px-3 py-1 gap-1.5",
    lg: "text-base px-4 py-2 gap-2",
  };
  const iconSize = { sm: 12, md: 14, lg: 16 };

  return (
    <span
      className={`inline-flex items-center bg-black/40 border border-gold-600/40 rounded-full text-gold-400 font-semibold ${sizeClasses[size]} ${className}`}
    >
      <Coins size={iconSize[size]} className="text-gold-500" />
      {formatChips(balance)}
    </span>
  );
}
