"use client";

import { useEffect, useRef } from "react";
import {
  type MatrixClient,
  type MatrixEvent,
  MatrixEventEvent,
  type Room,
  RoomEvent,
} from "matrix-js-sdk";

import { playChime } from "@/lib/chat/chime";
import { classifyIncoming } from "@/lib/chat/notifications";
import { directRoomMap } from "@/lib/chat/rooms";
import { chatNotifyMessage } from "@/lib/tauri/chat";

/**
 * OS notifications for incoming messages. For every live timeline event
 * (after decryption for encrypted rooms) the pure `classifyIncoming`
 * establishes the Matrix facts and Rust's `chat_notify_message` applies
 * the desktop policy — mentions in channels, every DM, unless the "Chat"
 * preference is off or the room is on screen in a focused window — and
 * shows the banner. Nothing is decided in the webview: it plays the
 * chime (`playChime`) exactly when Rust answers `playSound: true` — the
 * banner was shown and the Sound preference is on.
 *
 * `openRoomId` is the room the chat surface is showing, or `null` when the
 * user is on another page: a selected room that is not on screen must not
 * suppress its own notifications.
 *
 * The desktop port of the console's `useDesktopNotifications`; the browser
 * `Notification` API and the "click to open the room" handler are not
 * available through the OS notification plugin on desktop, so a click just
 * brings the app forward (the OS default).
 */
export function useChatNotifications(
  client: MatrixClient | null,
  openRoomId: string | null,
): void {
  const openRoomRef = useRef(openRoomId);
  openRoomRef.current = openRoomId;

  useEffect(() => {
    if (!client) return;

    const report = (room: Room, event: MatrixEvent) => {
      const message = classifyIncoming(client, room, event, {
        now: Date.now(),
        direct: directRoomMap(client),
        openRoomId: openRoomRef.current,
      });
      if (!message) return;
      chatNotifyMessage(message)
        .then((result) => (result.playSound ? playChime() : undefined))
        .catch((error) => {
          console.warn(
            `[chat] notification failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    };

    const onTimeline = (
      event: MatrixEvent,
      room: Room | undefined,
      toStartOfTimeline: boolean | undefined,
    ) => {
      if (!room || toStartOfTimeline) return;
      if (event.isBeingDecrypted() || event.shouldAttemptDecryption()) {
        event.once(MatrixEventEvent.Decrypted, () => report(room, event));
        return;
      }
      report(room, event);
    };

    client.on(RoomEvent.Timeline, onTimeline);
    return () => {
      client.off(RoomEvent.Timeline, onTimeline);
    };
  }, [client]);
}
