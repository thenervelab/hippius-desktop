"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { type MatrixClient, RoomEvent, RoomStateEvent } from "matrix-js-sdk";

import { useClientTick } from "@/components/chat/hooks/useClientTick";
import { type JoinableChannel, allChannelLinks, fetchJoinableChannels } from "@/lib/chat/spaces";

const EVENTS = [RoomStateEvent.Events, RoomEvent.MyMembership] as const;

export interface JoinableChannelsState {
  channels: JoinableChannel[];
  /** First load for this workspace still in flight. */
  loading: boolean;
  refresh: () => void;
}

/**
 * Channels of the active workspace we are not in yet, from the server's
 * `/hierarchy` (the workspace's own and its categories'). Refetched when
 * the workspace changes, when its child links change (a channel was
 * created, moved or archived) or when our own membership
 * somewhere changes (we joined one) — not on every state event, since each
 * fetch is a request.
 */
export function useJoinableChannels(client: MatrixClient, spaceId: string | null): JoinableChannelsState {
  const tick = useClientTick(client, EVENTS);
  const [state, setState] = useState<{ spaceId: string | null; channels: JoinableChannel[]; loaded: boolean }>({
    spaceId: null,
    channels: [],
    loaded: false,
  });
  const [refreshCount, setRefreshCount] = useState(0);

  // What would change the answer: the workspace's channel links (its own and
  // its categories') and which of them we are in.
  const key = useMemo(() => {
    const space = spaceId ? client.getRoom(spaceId) : null;
    if (!space) return "";
    return allChannelLinks(client, space)
      .map((c) => `${c.roomId}:${client.getRoom(c.roomId)?.getMyMembership() ?? "-"}`)
      .join("|");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, spaceId, tick]);

  useEffect(() => {
    const space = spaceId ? client.getRoom(spaceId) : null;
    if (!space) {
      setState({ spaceId, channels: [], loaded: true });
      return;
    }
    let cancelled = false;
    fetchJoinableChannels(client, space)
      .then((channels) => {
        if (!cancelled) setState({ spaceId, channels, loaded: true });
      })
      .catch(() => {
        // A server without /hierarchy, or offline: no browse list, no noise.
        if (!cancelled) setState({ spaceId, channels: [], loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, [client, spaceId, key, refreshCount]);

  const refresh = useCallback(() => setRefreshCount((n) => n + 1), []);

  return {
    channels: state.spaceId === spaceId ? state.channels : [],
    loading: state.spaceId !== spaceId || !state.loaded,
    refresh,
  };
}
