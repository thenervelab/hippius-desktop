"use client";

import {
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  type MatrixClient,
  type MatrixEvent,
  MatrixEventEvent,
  type Room,
  RoomEvent,
  RoomMemberEvent,
} from "matrix-js-sdk";
import { ArrowDown, Hash, Lock } from "lucide-react";

import {
  jumpToEventAtom,
  pendingGifsAtom,
} from "@/components/chat/chat-ui-atoms";
import { useClientTick } from "@/components/chat/hooks/useClientTick";
import type { UseTimelineResult } from "@/components/chat/hooks/useTimeline";
import MessageRow from "@/components/chat/MessageRow";
import PendingGifRow from "@/components/chat/PendingGifRow";
import { ensureEventLoaded, markReadUpTo } from "@/lib/chat/actions";
import type { RoomSummary } from "@/lib/chat/rooms";
import {
  formatDayLabel,
  isMessageLike,
  messageBody,
} from "@/lib/chat/timeline";
import { cn } from "@/lib/utils";

interface MessageListProps {
  client: MatrixClient;
  room: Room;
  summary: RoomSummary;
  /** Filter rows to those whose text contains the query (in-room search). */
  searchQuery: string | null;
  timeline: UseTimelineResult;
}

const BOTTOM_THRESHOLD = 48;
const TOP_THRESHOLD = 240;
// Rows are memoised and the SDK mutates events in place, so every change a
// row must reflect has to flow through this tick, decryption included.
const ROW_EVENTS = [
  RoomEvent.Receipt,
  RoomEvent.Redaction,
  RoomEvent.Timeline,
  RoomEvent.LocalEchoUpdated,
  MatrixEventEvent.Decrypted,
] as const;

/**
 * The scrolling timeline. Anchored to the bottom while the reader is there,
 * preserves scroll offset when older pages are prepended, sends a read
 * receipt for the newest event whenever we are at the bottom and the tab is
 * visible, and offers a "jump to latest" pill otherwise.
 */
export default function MessageList({
  client,
  room,
  summary,
  searchQuery,
  timeline,
}: MessageListProps) {
  const { items, events, loadOlder, canLoadOlder, loadingOlder } = timeline;
  const rowTick = useClientTick(client, ROW_EVENTS);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottomState] = useState(true);
  // The layout effect below runs on every timeline tick (decryption,
  // receipts, typing), so it must read the *current* position, never a value
  // captured by an earlier render — a stale `true` yanked readers back down
  // the instant they started scrolling up.
  const atBottomRef = useRef(true);
  const setAtBottom = useCallback((value: boolean) => {
    atBottomRef.current = value;
    setAtBottomState(value);
  }, []);
  const [newBelow, setNewBelow] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [jump, setJump] = useAtom(jumpToEventAtom);
  const pendingGifs = useAtomValue(pendingGifsAtom);
  // Optimistic GIF bubbles for this room's main timeline (threads render their own).
  const pendingHere = useMemo(
    () =>
      pendingGifs.filter(
        (p) => p.roomId === room.roomId && p.threadRootId === null,
      ),
    [pendingGifs, room.roomId],
  );
  const prevScroll = useRef<{ height: number; top: number } | null>(null);
  const lastEventCount = useRef(events.length);
  const me = client.getUserId();

  const byId = useMemo(() => {
    const map = new Map<string, MatrixEvent>();
    for (const event of events) {
      const id = event.getId();
      if (id) map.set(id, event);
    }
    return map;
  }, [events]);

  const visibleItems = useMemo(() => {
    if (!searchQuery?.trim()) return items;
    const q = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (item.kind !== "message") return item.kind === "day";
      const body = messageBody(item.event);
      const sender = room.getMember(item.event.getSender() ?? "")?.name ?? "";
      return (
        body.text.toLowerCase().includes(q) || sender.toLowerCase().includes(q)
      );
    });
  }, [items, searchQuery, room]);

  // Keep the viewport anchored when pages are prepended, and pinned to the
  // bottom only while the reader is there. Re-renders that do not change the
  // list (ticks) must not touch scrollTop at all.
  const lastLayoutKey = useRef<string>("");
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (prevScroll.current) {
      const delta = el.scrollHeight - prevScroll.current.height;
      el.scrollTop = prevScroll.current.top + delta;
      prevScroll.current = null;
      return;
    }
    const last = visibleItems.length
      ? visibleItems[visibleItems.length - 1].key
      : "";
    const key = `${room.roomId}|${visibleItems.length}|${last}`;
    if (key === lastLayoutKey.current) return;
    lastLayoutKey.current = key;
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [visibleItems, room.roomId]);

  // Growth of content below the fold (images decoding, embeds) while pinned.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const inner = el.firstElementChild;
    if (!inner) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [room.roomId]);

  // A new room starts at the bottom.
  useEffect(() => {
    setAtBottom(true);
    setNewBelow(0);
    lastLayoutKey.current = "";
  }, [room.roomId, setAtBottom]);

  // Count messages that arrived while scrolled up.
  useEffect(() => {
    const added = events.length - lastEventCount.current;
    lastEventCount.current = events.length;
    if (added > 0 && !atBottom) {
      const fresh = events
        .slice(-added)
        .filter((e) => isMessageLike(e) && e.getSender() !== me).length;
      if (fresh) setNewBelow((n) => n + fresh);
    }
    if (atBottom) setNewBelow(0);
  }, [events, atBottom, me]);

  // Read receipt for the latest event when at the bottom and visible.
  const lastEvent = events.length ? events[events.length - 1] : null;
  const lastEventId = lastEvent?.getId() ?? null;
  useEffect(() => {
    if (!atBottom || !lastEvent || !lastEventId) return;
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    )
      return;
    const timer = window.setTimeout(() => {
      void markReadUpTo(client, room, lastEvent).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [client, room, atBottom, lastEvent, lastEventId]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && atBottom && lastEvent) {
        void markReadUpTo(client, room, lastEvent).catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [client, room, atBottom, lastEvent]);

  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nowAtBottom = distance < BOTTOM_THRESHOLD;
      if (nowAtBottom !== atBottomRef.current) setAtBottom(nowAtBottom);
      if (el.scrollTop < TOP_THRESHOLD && canLoadOlder && !loadingOlder) {
        prevScroll.current = { height: el.scrollHeight, top: el.scrollTop };
        void loadOlder().then((more) => {
          if (!more) prevScroll.current = null;
        });
      }
    },
    [setAtBottom, canLoadOlder, loadingOlder, loadOlder],
  );

  const scrollToBottom = () => {
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  };

  // Permalink jump: load the event if needed, scroll to it, flash it.
  useEffect(() => {
    if (!jump || jump.roomId !== room.roomId) return;
    let cancelled = false;
    (async () => {
      const target =
        byId.get(jump.eventId) ??
        (await ensureEventLoaded(client, room, jump.eventId));
      if (cancelled) return;
      if (!target) {
        setJump(null);
        return;
      }
      // Pull pages until the event is in the live window (bounded).
      for (
        let i = 0;
        i < 10 &&
        !byId.has(jump.eventId) &&
        !room
          .getLiveTimeline()
          .getEvents()
          .some((e) => e.getId() === jump.eventId);
        i++
      ) {
        const more = await loadOlder();
        if (!more || cancelled) break;
      }
      requestAnimationFrame(() => {
        if (cancelled) return;
        const el = document.getElementById(`msg-${jump.eventId}`);
        el?.scrollIntoView({ block: "center" });
        setHighlightId(jump.eventId);
        setAtBottom(false);
        setJump(null);
        window.setTimeout(
          () => setHighlightId((id) => (id === jump.eventId ? null : id)),
          2500,
        );
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.eventId, jump?.roomId, room.roomId]);

  const empty = visibleItems.filter((i) => i.kind === "message").length === 0;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={`Messages in ${summary.name}`}
      >
        <div>
          {!canLoadOlder && !searchQuery ? (
            <RoomIntro summary={summary} />
          ) : null}
          {loadingOlder ? (
            <div
              className="flex justify-center py-3"
              aria-label="Loading older messages"
            >
              <span className="size-4 animate-spin rounded-full border-2 border-grey-80 border-t-primary-50 dark:border-black-500 dark:border-t-primary-40" />
            </div>
          ) : null}

          {empty && searchQuery ? (
            <p className="px-4 py-10 text-center text-sm text-grey-60 dark:text-grey-dark-700">
              No messages match “{searchQuery}”.
            </p>
          ) : null}

          {visibleItems.map((item) => {
            switch (item.kind) {
              case "day":
                return (
                  <div
                    key={item.key}
                    className="sticky top-0 z-[5] my-2 flex items-center gap-3 px-4"
                    role="separator"
                    aria-label={formatDayLabel(item.ts)}
                  >
                    <span className="h-px flex-1 bg-grey-80 dark:bg-black-500" />
                    <span className="rounded-full border border-grey-80 bg-white px-3 py-0.5 text-xs font-medium text-grey-10 dark:border-black-500 dark:bg-black-300 dark:text-grey-light-100">
                      {formatDayLabel(item.ts)}
                    </span>
                    <span className="h-px flex-1 bg-grey-80 dark:bg-black-500" />
                  </div>
                );
              case "new-line":
                return (
                  <div
                    key={item.key}
                    className="my-1 flex items-center gap-2 px-4"
                    role="separator"
                    aria-label="New messages"
                  >
                    <span className="h-px flex-1 bg-error-50 dark:bg-error-50" />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-error-50 dark:text-error-50">
                      New
                    </span>
                  </div>
                );
              case "state":
                return (
                  <p
                    key={item.key}
                    className="px-4 py-1 pl-16 text-xs text-grey-60 dark:text-grey-dark-700"
                  >
                    {item.text}
                  </p>
                );
              case "message": {
                const replyToId = messageBody(item.event).replyToId;
                return (
                  <MessageRow
                    key={item.key}
                    client={client}
                    room={room}
                    event={item.event}
                    groupStart={item.groupStart || Boolean(searchQuery)}
                    tick={rowTick}
                    highlighted={
                      highlightId !== null && highlightId === item.event.getId()
                    }
                    replyTo={replyToId ? (byId.get(replyToId) ?? null) : null}
                  />
                );
              }
            }
          })}
          {pendingHere.map((item) => (
            <PendingGifRow
              key={item.id}
              client={client}
              room={room}
              item={item}
            />
          ))}
          <TypingLine room={room} client={client} />
        </div>
      </div>

      {!atBottom ? (
        <button
          type="button"
          onClick={scrollToBottom}
          className={cn(
            "absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-grey-80 bg-white px-3 py-1 text-xs font-medium text-grey-10 shadow-dialog hover:bg-grey-90 dark:border-black-500 dark:bg-black-300 dark:text-grey-light-100 dark:hover:bg-black-500",
            newBelow > 0 &&
              "border-primary-50 text-primary-50 dark:border-primary-40 dark:text-primary-40",
          )}
        >
          <ArrowDown className="size-3.5" aria-hidden />
          {newBelow > 0
            ? `${newBelow} new message${newBelow === 1 ? "" : "s"}`
            : "Jump to latest"}
        </button>
      ) : null}
    </div>
  );
}

function RoomIntro({ summary }: { summary: RoomSummary }) {
  return (
    <div className="px-4 pb-4 pt-8">
      <div className="mb-3 inline-flex size-12 items-center justify-center rounded-lg bg-grey-90 text-grey-10 dark:bg-black-500 dark:text-grey-light-100">
        {summary.isPublic ? (
          <Hash className="size-6" aria-hidden />
        ) : (
          <Lock className="size-6" aria-hidden />
        )}
      </div>
      <h2 className="text-xl font-bold text-grey-10 dark:text-grey-light-100">
        {summary.kind === "dm" ? summary.name : `Welcome to #${summary.name}`}
      </h2>
      <p className="mt-1 text-sm text-grey-60 dark:text-grey-dark-700">
        {summary.kind === "dm"
          ? "This is the very beginning of your direct message history."
          : summary.topic
            ? summary.topic
            : `This is the very beginning of #${summary.name}. ${summary.isPublic ? "Anyone in the workspace can join." : "Only invited members can see it."}`}
      </p>
    </div>
  );
}

/** "Alice is typing…" line pinned to the end of the list. */
function TypingLine({ client, room }: { client: MatrixClient; room: Room }) {
  const tick = useClientTick(client, [RoomMemberEvent.Typing]);
  const names = useMemo(
    () =>
      room
        .getMembers()
        .filter((m) => m.typing && m.userId !== client.getUserId())
        .map((m) => m.name),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, client, tick],
  );
  if (names.length === 0) return <div className="h-5" aria-hidden />;
  const text =
    names.length === 1
      ? `${names[0]} is typing…`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing…`
        : "Several people are typing…";
  return (
    <p
      className="h-5 px-4 pl-16 text-xs text-grey-60 dark:text-grey-dark-700"
      aria-live="polite"
    >
      {text}
    </p>
  );
}
