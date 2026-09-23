"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ClientEvent,
  Direction,
  type EventTimeline,
  type MatrixClient,
  type MatrixEvent,
  MatrixEventEvent,
  type Room,
  RoomEvent,
} from "matrix-js-sdk";

import { useClientTick } from "@/components/chat/hooks/useClientTick";
import { type TimelineItem, buildTimelineItems, readMarkerOf } from "@/lib/chat/timeline";

const PAGE_SIZE = 40;
const INITIAL_MIN_EVENTS = 30;

const TIMELINE_EVENTS = [
  RoomEvent.Timeline,
  RoomEvent.TimelineReset,
  RoomEvent.Redaction,
  RoomEvent.LocalEchoUpdated,
  RoomEvent.Receipt,
  ClientEvent.AccountData,
  // Decryption finishes asynchronously per event, and may succeed on a
  // retry long after a first failure; the client re-emits it for all of them.
  MatrixEventEvent.Decrypted,
] as const;

export interface UseTimelineResult {
  items: TimelineItem[];
  /** Raw live events (renderable or not), oldest first. */
  events: MatrixEvent[];
  /** Fetch one more page backwards. Resolves `true` if more may exist. */
  loadOlder: () => Promise<boolean>;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  /** Read marker at mount time, frozen so the "New" line does not jump as we read. */
  readMarkerEventId: string | null;
}

/**
 * The room's live timeline as list items, with backwards pagination.
 *
 * The SDK mutates `EventTimeline` in place, so we re-read `getEvents()` on
 * every relevant emit (coalesced per frame by `useClientTick`) rather than
 * holding our own copy.
 */
export function useTimeline(client: MatrixClient, room: Room): UseTimelineResult {
  const tick = useClientTick(client, TIMELINE_EVENTS);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [canLoadOlder, setCanLoadOlder] = useState(true);
  const myUserId = client.getUserId();

  // Freeze the read marker at open time; live updates would move the "New"
  // line under the reader as we send receipts.
  const readMarkerRef = useRef<string | null | undefined>(undefined);
  if (readMarkerRef.current === undefined) readMarkerRef.current = readMarkerOf(room);

  const liveTimeline: EventTimeline = room.getLiveTimeline();

  const events = useMemo(
    () => {
      // Walk back through neighbouring timelines so paginated pages are included.
      const chunks: MatrixEvent[][] = [];
      let timeline: EventTimeline | null = liveTimeline;
      while (timeline) {
        chunks.unshift(timeline.getEvents());
        timeline = timeline.getNeighbouringTimeline(Direction.Backward);
      }
      return chunks.flat();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveTimeline, tick],
  );

  const loadOlder = useCallback(async (): Promise<boolean> => {
    if (loadingOlder) return canLoadOlder;
    const oldest = (() => {
      let t: EventTimeline = liveTimeline;
      let prev = t.getNeighbouringTimeline(Direction.Backward);
      while (prev) {
        t = prev;
        prev = t.getNeighbouringTimeline(Direction.Backward);
      }
      return t;
    })();
    if (!oldest.getPaginationToken(Direction.Backward)) {
      setCanLoadOlder(false);
      return false;
    }
    setLoadingOlder(true);
    try {
      const more = await client.paginateEventTimeline(oldest, { backwards: true, limit: PAGE_SIZE });
      setCanLoadOlder(more);
      return more;
    } catch {
      return true;
    } finally {
      setLoadingOlder(false);
    }
  }, [client, liveTimeline, loadingOlder, canLoadOlder]);

  // Make sure a freshly opened room has a screenful of history.
  useEffect(() => {
    if (events.length >= INITIAL_MIN_EVENTS || !canLoadOlder || loadingOlder) return;
    void loadOlder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.roomId, events.length, canLoadOlder]);

  const items = useMemo(
    () => buildTimelineItems(room, events, { readMarkerEventId: readMarkerRef.current ?? null, myUserId }),
    [room, events, myUserId],
  );

  return { items, events, loadOlder, canLoadOlder, loadingOlder, readMarkerEventId: readMarkerRef.current ?? null };
}
