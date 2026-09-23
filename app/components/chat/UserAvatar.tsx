"use client";

import dynamic from "next/dynamic";
import type { MatrixClient } from "matrix-js-sdk";

import { useMediaUrl } from "@/components/chat/hooks/useMediaUrl";
import type { PresenceState } from "@/lib/chat/presence";
import { cn } from "@/lib/utils";

/** Identicon palette; the same four the account avatar in the top bar uses (`ProfileCard`). */
const AVATAR_COLORS = ["#D3DFF8", "#183E91", "#3167DE", "#A6F4C5"];

const BoringAvatar = dynamic(() => import("boring-avatars"), { ssr: false });

interface UserAvatarProps {
  client: MatrixClient | null;
  /** Seed for the generated avatar; the Matrix user id or room id. */
  seed: string;
  /** `mxc://` avatar to prefer over the generated one. */
  avatarMxc?: string | null;
  size?: number;
  /** Presence dot in the corner, when known. */
  presence?: PresenceState;
  /** Rounded square for rooms, circle for people. */
  shape?: "circle" | "square";
  className?: string;
  alt?: string;
}

/**
 * The console's seeded pixel avatar (same palette as the profile card),
 * replaced by the user's uploaded picture when they have one. Presence is
 * a dot on the lower-right corner, as in Slack.
 */
export default function UserAvatar({
  client,
  seed,
  avatarMxc,
  size = 32,
  presence,
  shape = "circle",
  className,
  alt = "",
}: UserAvatarProps) {
  const media = useMediaUrl(client, avatarMxc ?? null, { width: size * 2, height: size * 2, method: "crop" });
  const radius = shape === "circle" ? "rounded-full" : "rounded-md";

  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <span className={cn("flex size-full overflow-hidden bg-grey-90 dark:bg-black-500", radius)}>
        {media.status === "ready" ? (
          <img src={media.url} alt={alt} width={size} height={size} className="size-full object-cover" />
        ) : (
          <BoringAvatar colors={AVATAR_COLORS} name={seed} size={size} variant="pixel" square />
        )}
      </span>
      {presence ? <PresenceDot state={presence} className="absolute -bottom-0.5 -right-0.5 ring-2 ring-white dark:ring-black-300" /> : null}
    </span>
  );
}

export function PresenceDot({ state, className }: { state: PresenceState; className?: string }) {
  const tone =
    state === "online"
      ? "bg-success-50 dark:bg-success-40"
      : state === "unavailable"
        ? "bg-warning-50 dark:bg-warning-40"
        : "border border-grey-60 bg-transparent dark:border-grey-dark-500";
  const label =
    state === "online" ? "Active" : state === "unavailable" ? "Away" : state === "offline" ? "Away" : "Status unknown";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("inline-block size-2.5 shrink-0 rounded-full", tone, className)}
    />
  );
}
