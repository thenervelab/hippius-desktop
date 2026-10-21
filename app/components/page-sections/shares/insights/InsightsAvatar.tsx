import { User } from "lucide-react";

import { cn } from "@/lib/utils";
import { avatarFor } from "./insightsView";

const SIZE = {
  xs: "size-4 text-[7px]",
  sm: "size-5 text-[8.5px]",
  md: "size-7 text-[10.5px]",
} as const;

const ICON = { xs: "size-2.5", sm: "size-3", md: "size-3.5" } as const;

/**
 * A viewer's or commenter's avatar: initials on a colour picked from their
 * name (`avatarFor`), or the neutral person for someone without a name.
 * Decorative: the name always sits beside it, or in the label of what holds it.
 */
export function InsightsAvatar({
  name,
  size = "md",
  ring = false,
  className,
}: {
  name: string | null;
  size?: keyof typeof SIZE;
  /** A ring in the surface colour, for avatars that overlap something. */
  ring?: boolean;
  className?: string;
}) {
  const avatar = avatarFor(name);
  return (
    <span
      aria-hidden
      data-testid="insights-avatar"
      data-anonymous={avatar ? undefined : "true"}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none tracking-[0.02em]",
        SIZE[size],
        avatar ? "text-white" : "bg-grey-90 text-grey-50 dark:bg-[#333] dark:text-grey-dark-600",
        ring && "ring-2 ring-white dark:ring-[#1f1f1f]",
        className,
      )}
      style={avatar ? { backgroundColor: avatar.color } : undefined}
    >
      {avatar ? avatar.initials : <User className={ICON[size]} strokeWidth={2.25} />}
    </span>
  );
}
