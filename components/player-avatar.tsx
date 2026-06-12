import { getInitials, getAvatarColor } from "@/lib/utils";

interface PlayerAvatarProps {
  username: string;
  userId: string;
  size?: "sm" | "md" | "lg" | "xl";
  showName?: boolean;
  isHost?: boolean;
}

export function PlayerAvatar({
  username,
  userId,
  size = "md",
  showName = false,
  isHost = false,
}: PlayerAvatarProps) {
  const sizeClasses = {
    sm: "w-8 h-8 text-xs",
    md: "w-10 h-10 text-sm",
    lg: "w-14 h-14 text-lg",
    xl: "w-20 h-20 text-2xl",
  };

  const colorClass = getAvatarColor(userId);

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative">
        <div
          className={`${sizeClasses[size]} ${colorClass} rounded-full flex items-center justify-center font-bold text-white border-2 border-white/10 shadow-lg`}
        >
          {getInitials(username)}
        </div>
        {isHost && (
          <span className="absolute -top-1 -right-1 text-base leading-none" title="Host">
            👑
          </span>
        )}
      </div>
      {showName && (
        <span className="text-xs text-muted-foreground truncate max-w-[72px] text-center">
          {username}
        </span>
      )}
    </div>
  );
}
