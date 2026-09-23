"use client";

import { useEffect, useState } from "react";
import type {
  ClientEvent,
  MatrixClient,
  MatrixEventEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  ThreadEvent,
  UserEvent,
} from "matrix-js-sdk";

type ClientEventName =
  | ClientEvent
  | RoomEvent
  | RoomStateEvent
  | RoomMemberEvent
  | UserEvent
  | ThreadEvent
  | MatrixEventEvent.Decrypted;

/**
 * Re-render when any of the given SDK events fires, coalesced to one
 * update per animation frame. The SDK emits room events on the client too
 * (it re-emits from every room), so one subscription covers all rooms.
 *
 * `MatrixEventEvent.Decrypted` is re-emitted on the client for every
 * encrypted event the event mapper produced (sync, pagination, relations),
 * including later retries after a failed decryption once the key arrives.
 * Listening here, rather than on each event, has no window between the
 * render that saw the event undecrypted and the effect that would have
 * subscribed, and no per-event bookkeeping to get wrong.
 *
 * Returns a counter to put in `useMemo` dependency lists.
 */
export function useClientTick(client: MatrixClient | null, events: readonly ClientEventName[]): number {
  const [tick, setTick] = useState(0);
  const key = events.join("|");

  useEffect(() => {
    if (!client) return;
    let frame: number | null = null;
    const bump = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setTick((t) => t + 1);
      });
    };
    const names = key.split("|") as ClientEventName[];
    for (const name of names) client.on(name as ClientEvent, bump);
    return () => {
      for (const name of names) client.off(name as ClientEvent, bump);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [client, key]);

  return tick;
}
