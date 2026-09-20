"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Direction, type MatrixClient, type MatrixEvent, MatrixEventEvent, type Room, RoomEvent, type Thread, ThreadEvent } from "matrix-js-sdk";

import { useClientTick } from "@/components/chat/hooks/useClientTick";
import { ensureEventLoaded } from "@/lib/chat/actions";
import { threadReplies } from "@/lib/chat/threads";

export interface UseThreadResult {
  root: MatrixEvent | null;
  thread: Thread | null;
  /** Replies currently loaded, oldest first. Older ones may exist: see `canLoadOlder`. */
  replies: MatrixEvent[];
  /** The root is being fetched or the thread's first page is loading. */
  loading: boolean;
  missing: boolean;
  /** Fetch one more page of earlier replies. Resolves `true` if more may exist. */
  loadOlder: () => Promise<boolean>;
  canLoadOlder: boolean;
  loadingOlder: boolean;
}

const PAGE_SIZE = 50;
/** Fill a freshly opened thread to at least this many replies before waiting for a scroll. */
const INITIAL_MIN_REPLIES = 30;

const THREAD_EVENTS = [
  ThreadEvent.Update,
  ThreadEvent.NewReply,
  RoomEvent.Timeline,
  RoomEvent.Redaction,
  RoomEvent.Receipt,
  RoomEvent.LocalEchoUpdated,
  // Replies decrypt asynchronously; `threadReplies` filters on decrypted content.
  MatrixEventEvent.Decrypted,
] as const;

/**
 * The thread for `rootEventId`: root, replies, live, with backwards
 * pagination. Creates the SDK `Thread` if the root is known but has no
 * replies yet (so the panel can open on "Reply in thread" for a fresh
 * message) and fetches the root when it is not in the loaded window (deep
 * link).
 *
 * The SDK loads the thread's most recent page itself when the `Thread` is
 * created; everything earlier comes through `loadOlder`, page by page,
 * until the thread timeline has no backwards pagination token left.
 */
export function useThread(client: MatrixClient, room: Room, rootEventId: string): UseThreadResult {
  const tick = useClientTick(client, THREAD_EVENTS);
  const [rootLoading, setRootLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [fetchTick, setFetchTick] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [paginationTick, setPaginationTick] = useState(0);

  const root = room.findEventById(rootEventId) ?? null;

  useEffect(() => {
    if (root) return;
    let cancelled = false;
    setRootLoading(true);
    setMissing(false);
    ensureEventLoaded(client, room, rootEventId)
      .then((event) => {
        if (cancelled) return;
        if (!event) setMissing(true);
        setFetchTick((t) => t + 1);
      })
      .catch(() => !cancelled && setMissing(true))
      .finally(() => !cancelled && setRootLoading(false));
    return () => {
      cancelled = true;
    };
  }, [client, room, rootEventId, root]);

  const thread = useMemo(
    () => {
      const existing = room.getThread(rootEventId);
      if (existing) return existing;
      const rootEvent = room.findEventById(rootEventId);
      if (!rootEvent) return null;
      return room.createThread(rootEventId, rootEvent, [], false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, rootEventId, tick, fetchTick],
  );

  // The SDK fetches the thread's latest page when the Thread is created and
  // flips `initialEventsFetched` (with a TimelineReset that reaches our
  // tick); the panel shows its loading state until then.
  const initialFetched = thread?.initialEventsFetched ?? false;
  const loading = rootLoading || (thread !== null && !initialFetched);

  const replies = useMemo(
    () => (thread ? threadReplies(thread) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [thread, tick, paginationTick],
  );

  // A thread timeline is a single EventTimeline (no neighbours): the token
  // on it says whether the server has earlier replies. Re-read on every
  // tick, since pagination and the SDK's own initial fetch both move it.
  const canLoadOlder = useMemo(
    () => Boolean(thread && initialFetched && thread.liveTimeline.getPaginationToken(Direction.Backward)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [thread, initialFetched, tick, paginationTick],
  );

  const loadOlder = useCallback(async (): Promise<boolean> => {
    if (!thread || loadingOlder) return canLoadOlder;
    const timeline = thread.liveTimeline;
    if (!timeline.getPaginationToken(Direction.Backward)) return false;
    setLoadingOlder(true);
    try {
      const more = await client.paginateEventTimeline(timeline, { backwards: true, limit: PAGE_SIZE });
      // Pagination adds to the timeline without a room-level emit we listen to.
      setPaginationTick((t) => t + 1);
      return more;
    } catch {
      return true;
    } finally {
      setLoadingOlder(false);
    }
  }, [client, thread, loadingOlder, canLoadOlder]);

  // Make sure a freshly opened thread shows a screenful, not just the
  // SDK's first page.
  useEffect(() => {
    if (!canLoadOlder || loadingOlder || replies.length >= INITIAL_MIN_REPLIES) return;
    void loadOlder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootEventId, canLoadOlder, replies.length]);

  return {
    root: root ?? thread?.rootEvent ?? null,
    thread,
    replies,
    loading,
    missing,
    loadOlder,
    canLoadOlder,
    loadingOlder,
  };
}
