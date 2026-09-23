"use client";

import { useEffect, useRef } from "react";
import { ClientEvent, type MatrixClient, RoomEvent } from "matrix-js-sdk";

import { useClientTick } from "@/components/chat/hooks/useClientTick";
import { attentionCount, summariseRooms } from "@/lib/chat/rooms";
import { chatSetUnreadBadge } from "@/lib/tauri/chat";

const UNREAD_EVENTS = [
  ClientEvent.Room,
  ClientEvent.DeleteRoom,
  ClientEvent.AccountData,
  ClientEvent.Sync,
  RoomEvent.Timeline,
  RoomEvent.Receipt,
  RoomEvent.MyMembership,
  RoomEvent.UnreadNotifications,
] as const;

/**
 * Mirror the attention count (unread DMs + channel mentions, see
 * `attentionCount`) into Rust, which owns every OS surface: dock/taskbar
 * badge, `(N) Hippius` window title, tray popover. Reported only when the
 * number changes, and reset to zero when the client goes away (sign-out of
 * chat) so no stale badge outlives the session — logout resets it on the
 * Rust side as well.
 */
export function useChatUnreadBadge(client: MatrixClient | null): void {
  const tick = useClientTick(client, UNREAD_EVENTS);
  const lastReported = useRef<number | null>(null);

  useEffect(() => {
    const count = client ? attentionCount(summariseRooms(client)) : 0;
    if (lastReported.current === count) return;
    lastReported.current = count;
    chatSetUnreadBadge(count).catch((error) => {
      console.warn(
        `[chat] unread badge failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    // `tick` is the "something room-shaped changed" signal that re-runs the
    // recount; it is not read inside the effect.
  }, [client, tick]);
}
