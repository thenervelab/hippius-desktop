"use client";

import { useCallback, useEffect, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";

export interface RoomRosterState {
  /** The room's full membership is in memory; member getters are complete. */
  loaded: boolean;
  /** The load failed; `retry` asks again. */
  error: string | null;
  retry: () => void;
}

/**
 * Make a room's member list complete before anything is decided from it.
 * Members are lazy-loaded: sync only sends the senders of what we saw, so
 * `getJoinedMembers()` is a sample until `loadMembersIfNeeded()` fetched
 * `/members`. The SDK caches the result per room, so this is one request
 * per room per session.
 */
export function useRoomRoster(client: MatrixClient, roomId: string | null): RoomRosterState {
  const [state, setState] = useState<{ roomId: string | null; loaded: boolean; error: string | null }>({
    roomId: null,
    loaded: false,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const room = roomId ? client.getRoom(roomId) : null;
    if (!room) {
      setState({ roomId, loaded: false, error: roomId ? "Room not available" : null });
      return;
    }
    if (room.membersLoaded()) {
      setState({ roomId, loaded: true, error: null });
      return;
    }
    let cancelled = false;
    setState({ roomId, loaded: false, error: null });
    room
      .loadMembersIfNeeded()
      .then(() => {
        if (!cancelled) setState({ roomId, loaded: true, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ roomId, loaded: false, error: error instanceof Error ? error.message : "Could not load members" });
      });
    return () => {
      cancelled = true;
    };
  }, [client, roomId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const current = state.roomId === roomId;
  return { loaded: current && state.loaded, error: current ? state.error : null, retry };
}
