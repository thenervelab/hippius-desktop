"use client";

import { type MouseEvent, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { Hash, Lock } from "lucide-react";

import UserAvatar from "@/components/chat/UserAvatar";
import type { PresenceState } from "@/lib/chat/presence";
import type { RoomSummary } from "@/lib/chat/rooms";
import { cn } from "@/lib/utils";

export interface RoomListItemProps {
  client: MatrixClient;
  room: RoomSummary;
  selected: boolean;
  presence?: PresenceState;
  onSelect: (roomId: string) => void;
  /** Right-click / long-press: open the room menu at this point. */
  onContextMenu?: (roomId: string, point: { x: number; y: number }) => void;
}

/**
 * One row of the sidebar. Unread rooms are bold; a badge shows mentions
 * (highlights) or, for DMs, every unread message — Slack's rule. Muted
 * rooms are dimmed and never show a badge.
 */
export default function RoomListItem({
  client,
  room,
  selected,
  presence,
  onSelect,
  onContextMenu,
}: RoomListItemProps) {
  const [hover, setHover] = useState(false);
  const badgeCount = room.muted ? 0 : room.kind === "dm" ? room.unread : room.highlight;
  const unread = !room.muted && room.unread > 0;

  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    if (!onContextMenu) return;
    event.preventDefault();
    onContextMenu(room.id, { x: event.clientX, y: event.clientY });
  };

  return (
    <button
      type="button"
      onClick={() => onSelect(room.id)}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-current={selected ? "page" : undefined}
      aria-label={`${room.kind === "dm" ? "" : "#"}${room.name}${badgeCount ? `, ${badgeCount} unread` : ""}`}
      data-room-id={room.id}
      className={cn(
        "group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-primary-50 dark:focus-visible:ring-primary-40",
        selected
          ? "bg-primary-50 text-white dark:bg-primary-50 dark:text-white"
          : cn(
              "text-grey-40 hover:bg-grey-90 dark:text-grey-dark-500 dark:hover:bg-black-500",
              unread && "font-semibold text-grey-10 dark:text-grey-light-100",
              room.muted && "opacity-60",
            ),
      )}
    >
      {room.kind === "dm" ? (
        <UserAvatar
          client={client}
          seed={room.dmUserId ?? room.id}
          avatarMxc={room.avatarMxc}
          size={20}
          presence={presence}
        />
      ) : room.isPublic ? (
        <Hash className="size-4 shrink-0 opacity-70" aria-hidden />
      ) : (
        <Lock className="size-4 shrink-0 opacity-70" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{room.name}</span>
      {badgeCount > 0 ? (
        <span
          className={cn(
            "ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold leading-none",
            selected
              ? "bg-white text-primary-50 dark:bg-white dark:text-primary-50"
              : "bg-error-50 text-white dark:bg-error-40 dark:text-white",
          )}
        >
          {badgeCount > 99 ? "99+" : badgeCount}
        </span>
      ) : hover && onContextMenu ? (
        <span
          role="button"
          tabIndex={-1}
          aria-label="Room options"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onContextMenu(room.id, { x: rect.left, y: rect.bottom });
          }}
          className={cn(
            "ml-auto inline-flex size-5 items-center justify-center rounded text-xs leading-none",
            selected
              ? "text-white hover:bg-white/20"
              : "text-grey-60 hover:bg-grey-80 dark:text-grey-dark-700 dark:hover:bg-black-300",
          )}
        >
          ⋯
        </span>
      ) : null}
    </button>
  );
}
