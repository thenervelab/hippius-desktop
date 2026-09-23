import { act, renderHook, waitFor } from "@testing-library/react";
import { EventEmitter } from "events";
import { Direction, type MatrixClient, type MatrixEvent, type Room, RoomEvent, type Thread } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/chat/actions", () => ({
  ensureEventLoaded: vi.fn(async () => null),
}));

import { useThread } from "@/components/chat/hooks/useThread";

const ROOT = "$root";

function fakeEvent(id: string): MatrixEvent {
  return { getId: () => id, getSender: () => "@a:x", getTs: () => 0 } as unknown as MatrixEvent;
}

/** A thread whose server side holds `total` replies, served newest-first in pages. */
function fakeThread(total: number, firstPage: number) {
  const all = Array.from({ length: total }, (_, i) => fakeEvent(`$r${i}`));
  let loaded = all.slice(total - firstPage);
  let token: string | null = firstPage < total ? "tok" : null;
  const thread = {
    id: ROOT,
    rootEvent: fakeEvent(ROOT),
    initialEventsFetched: true,
    length: total,
    liveTimeline: {
      getEvents: () => [thread.rootEvent, ...loaded],
      getPaginationToken: (dir: Direction) => (dir === Direction.Backward ? token : null),
    },
    /** Server answer to one backwards page. */
    serve(limit: number) {
      const remaining = total - loaded.length;
      const take = Math.min(limit, remaining);
      loaded = [...all.slice(remaining - take, remaining), ...loaded];
      token = loaded.length < total ? "tok" : null;
      return loaded.length < total;
    },
  };
  return thread;
}

function harness(thread: ReturnType<typeof fakeThread>) {
  const emitter = new EventEmitter();
  const pending: Array<{ limit: number; resolve: (more: boolean) => void }> = [];
  const client = Object.assign(emitter, {
    getUserId: () => "@me:x",
    paginateEventTimeline: vi.fn((_timeline: unknown, opts: { limit?: number }) => {
      return new Promise<boolean>((resolve) => {
        pending.push({ limit: opts.limit ?? 30, resolve });
      });
    }),
  }) as unknown as MatrixClient & EventEmitter;
  const room = {
    roomId: "!r:x",
    findEventById: (id: string) => (id === ROOT ? thread.rootEvent : undefined),
    getThread: () => thread as unknown as Thread,
    createThread: () => thread as unknown as Thread,
  } as unknown as Room;
  /** Complete the oldest pending page as the server would, then tick the timeline. */
  const answer = async () => {
    const req = pending.shift()!;
    const more = thread.serve(req.limit);
    await act(async () => {
      req.resolve(more);
      client.emit(RoomEvent.Timeline);
      vi.advanceTimersByTime(16);
    });
  };
  return { client, room, pending, answer };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 16) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useThread pagination", () => {
  it("fills a long thread to a screenful, then pages back on demand until the token runs out", async () => {
    const thread = fakeThread(120, 10);
    const h = harness(thread);
    const { result } = renderHook(() => useThread(h.client, h.room, ROOT));

    // Only 10 of 120 loaded: the hook asks for more on its own.
    await waitFor(() => expect(h.pending).toHaveLength(1));
    expect(result.current.loadingOlder).toBe(true);
    await h.answer();
    expect(result.current.replies).toHaveLength(60);
    expect(result.current.canLoadOlder).toBe(true);
    expect(result.current.loadingOlder).toBe(false);
    expect(h.pending).toHaveLength(0);

    // The reader scrolls up: one page.
    let more: Promise<boolean>;
    act(() => {
      more = result.current.loadOlder();
    });
    await waitFor(() => expect(h.pending).toHaveLength(1));
    await h.answer();
    expect(await more!).toBe(true);
    expect(result.current.replies).toHaveLength(110);

    act(() => {
      more = result.current.loadOlder();
    });
    await waitFor(() => expect(h.pending).toHaveLength(1));
    await h.answer();
    expect(await more!).toBe(false);
    expect(result.current.replies).toHaveLength(120);
    expect(result.current.replies[0].getId()).toBe("$r0");
    expect(result.current.canLoadOlder).toBe(false);

    // Nothing left: no request goes out.
    await act(async () => {
      expect(await result.current.loadOlder()).toBe(false);
    });
    expect(h.pending).toHaveLength(0);
  });

  it("does not page a short thread", async () => {
    const thread = fakeThread(5, 5);
    const h = harness(thread);
    const { result } = renderHook(() => useThread(h.client, h.room, ROOT));
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.replies).toHaveLength(5);
    expect(result.current.canLoadOlder).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(h.client.paginateEventTimeline).not.toHaveBeenCalled();
  });

  it("ignores a second request while one is in flight", async () => {
    const thread = fakeThread(200, 40);
    const h = harness(thread);
    const { result } = renderHook(() => useThread(h.client, h.room, ROOT));
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    // 40 ≥ the fill threshold: nothing automatic.
    expect(h.pending).toHaveLength(0);

    act(() => {
      void result.current.loadOlder();
    });
    await waitFor(() => expect(result.current.loadingOlder).toBe(true));
    act(() => {
      void result.current.loadOlder();
    });
    expect(h.pending).toHaveLength(1);
    await h.answer();
    expect(result.current.replies).toHaveLength(90);
  });
});
