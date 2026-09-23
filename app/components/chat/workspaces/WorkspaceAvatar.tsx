"use client";

import type { MatrixClient } from "matrix-js-sdk";

import { useMediaUrl } from "@/components/chat/hooks/useMediaUrl";
import { workspaceInitials } from "@/lib/chat/spaces";
import { cn } from "@/lib/utils";

interface WorkspaceAvatarProps {
  client: MatrixClient | null;
  name: string;
  avatarMxc?: string | null;
  size?: number;
  className?: string;
}

/**
 * A workspace's mark: its uploaded picture, else its initials on a tinted
 * square (Slack's rail). Rounded square so it reads as an organisation,
 * not a person. Ported from the console's `WorkspaceAvatar`.
 */
export default function WorkspaceAvatar({ client, name, avatarMxc, size = 36, className }: WorkspaceAvatarProps) {
  const media = useMediaUrl(client, avatarMxc ?? null, { width: size * 2, height: size * 2, method: "crop" });
  return (
    <span
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-lg bg-primary-50 font-semibold text-white dark:bg-primary-40",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      aria-hidden
    >
      {media.status === "ready" ? (
        <img src={media.url} alt="" width={size} height={size} className="size-full object-cover" />
      ) : (
        workspaceInitials(name)
      )}
    </span>
  );
}
