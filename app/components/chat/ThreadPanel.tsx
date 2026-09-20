"use client";

import { type UIEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { type MatrixClient, MatrixEventEvent, type Room, RoomEvent } from "matrix-js-sdk";

import Composer from "@/components/chat/Composer";
import { Button } from "@/components/ui/button";
import { useClientTick } from "@/components/chat/hooks/useClientTick";
import { useThread } from "@/components/chat/hooks/useThread";
import MessageRow from "@/components/chat/MessageRow";
import PanelHeader from "@/components/chat/PanelHeader";
import { markThreadReadUpTo } from "@/lib/chat/actions";
import { roomLabel } from "@/lib/chat/rooms";
import type { RoomSummary } from "@/lib/chat/rooms";
import { GROUP_WINDOW_MS } from "@/lib/chat/timeline";

// Rows are memoised and the SDK mutates events in place, so every change a
// row must reflect has to flow through this tick, decryption included.
const THREAD_ROW_EVENTS = [RoomEvent.Receipt, RoomEvent.LocalEchoUpdated, RoomEvent.Redaction, MatrixEventEvent.Decrypted] as const;

/** Distance from the top (px) at which earlier replies start loading. */
const TOP_THRESHOLD = 160;
/** Distance from the bottom (px) within which new replies keep the view pinned. */
const BOTTOM_THRESHOLD = 48;

interface ThreadPanelProps {
  client: MatrixClient;
  room: Room;
  summary: RoomSummary;
  rootEventId: string;
}

/** Right column: a thread — root, replies, its own composer. */
export default function ThreadPanel({ client, room, summary, rootEventId }: ThreadPanelProps) {
  const { root, thread, replies, loading, missing, loadOlder, canLoadOlder, loadingOlder } = useThread(client, room, rootEventId);
  const tick = useClientTick(client, THREAD_ROW_EVENTS);
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = replies.length;
  // Set before a backwards page is requested; consumed by the layout effect
  // that keeps the reply under the reader's eyes where it was.
  const prevScroll = useRef<{ height: number; top: number } | null>(null);
  const atBottom = useRef(true);

  // Older pages prepend: restore the offset. New replies at the bottom while
  // the reader is there: stay pinned. Otherwise leave the scroll alone.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prevScroll.current) {
      el.scrollTop = prevScroll.current.top + (el.scrollHeight - prevScroll.current.height);
      prevScroll.current = null;
      return;
    }
    if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [count, rootEventId]);

  const requestOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !canLoadOlder || loadingOlder) return;
    prevScroll.current = { height: el.scrollHeight, top: el.scrollTop };
    void loadOlder().then((more) => {
      if (!more) prevScroll.current = null;
    });
  }, [canLoadOlder, loadingOlder, loadOlder]);

  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
      if (el.scrollTop < TOP_THRESHOLD) requestOlder();
    },
    [requestOlder],
  );

  // Opening the thread reads it.
  useEffect(() => {
    const last = replies[replies.length - 1];
    if (last && thread) void markThreadReadUpTo(client, room, last).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, room, thread, count]);

  const events = useMemo(() => (root ? [root, ...replies] : replies), [root, replies]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Thread" subtitle={roomLabel(summary)} />

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto py-2">
        {missing ? (
          <p className="px-4 py-10 text-center text-sm text-grey-60 dark:text-grey-dark-700">This message is no longer available.</p>
        ) : null}
        {!root && loading ? <ThreadSkeleton /> : null}
        {root ? <MessageRow client={client} room={room} event={root} groupStart tick={tick} threadRootId={rootEventId} /> : null}
        {root ? (
          <div className="my-2 flex items-center gap-2 px-4" role="separator">
            <span className="text-xs text-grey-60 dark:text-grey-dark-700">
              {thread && thread.length > count ? `${thread.length} replies` : count === 0 ? "No replies yet" : `${count} ${count === 1 ? "reply" : "replies"}`}
            </span>
            <span className="h-px flex-1 bg-grey-80 dark:bg-black-500" />
          </div>
        ) : null}
        {root && loading ? <ThreadSkeleton /> : null}
        {root && !loading && (canLoadOlder || loadingOlder) ? (
          <div className="flex justify-center px-4 pb-2">
            <Button variant="ghost" size="sm" onClick={requestOlder} loading={loadingOlder} disabled={loadingOlder}>
              {loadingOlder ? "Loading earlier replies…" : "Load earlier replies"}
            </Button>
          </div>
        ) : null}
        {replies.map((event, index) => {
          const prev = index === 0 ? null : replies[index - 1];
          const groupStart = !prev || prev.getSender() !== event.getSender() || event.getTs() - prev.getTs() > GROUP_WINDOW_MS;
          return <MessageRow key={event.getId() ?? `${index}`} client={client} room={room} event={event} groupStart={groupStart} tick={tick} threadRootId={rootEventId} />;
        })}
      </div>

      {root && room.maySendMessage() ? (
        <Composer client={client} room={room} threadRootId={rootEventId} events={events} placeholder="Reply in thread" autoFocus />
      ) : null}
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="animate-pulse space-y-3 px-4 py-3" aria-hidden>
      <div className="flex gap-3">
        <div className="size-9 rounded-md bg-grey-90 dark:bg-black-500" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-1/3 rounded bg-grey-90 dark:bg-black-500" />
          <div className="h-3 w-5/6 rounded bg-grey-90 dark:bg-black-500" />
          <div className="h-3 w-2/3 rounded bg-grey-90 dark:bg-black-500" />
        </div>
      </div>
    </div>
  );
}
