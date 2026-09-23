"use client";

import { useEffect, useMemo, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";

import { type PresenceInfo, PresenceTracker, UNKNOWN_PRESENCE } from "@/lib/chat/presence";

const trackers = new WeakMap<MatrixClient, PresenceTracker>();

export function presenceTrackerFor(client: MatrixClient): PresenceTracker {
  let tracker = trackers.get(client);
  if (!tracker) {
    tracker = new PresenceTracker(client);
    trackers.set(client, tracker);
  }
  return tracker;
}

/**
 * Presence for a set of users. Tracks them (polling) while mounted and
 * returns a lookup that changes identity when any presence changes.
 */
export type PresenceLookup = (userId: string) => PresenceInfo;

export function usePresence(
  client: MatrixClient | null,
  userIds: readonly string[],
): PresenceLookup {
  const [version, setVersion] = useState(0);
  const key = userIds.join("|");

  useEffect(() => {
    if (!client || !key) return;
    const tracker = presenceTrackerFor(client);
    const untrack = tracker.track(key.split("|"));
    const unsubscribe = tracker.subscribe(() => setVersion((v) => v + 1));
    return () => {
      untrack();
      unsubscribe();
    };
  }, [client, key]);

  return useMemo(() => {
    if (!client) return () => UNKNOWN_PRESENCE;
    const tracker = presenceTrackerFor(client);
    return (userId: string) => tracker.get(userId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, version]);
}
