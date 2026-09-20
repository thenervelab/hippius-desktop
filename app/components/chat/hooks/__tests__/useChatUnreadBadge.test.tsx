import { act, renderHook } from "@testing-library/react";
import { EventEmitter } from "events";
import { type MatrixClient, RoomEvent } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

const rooms = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/chat/rooms", () => ({
  summariseRooms: () => ({ channels: [], dms: [], invites: [] }),
  attentionCount: () => rooms.count,
}));

import { useChatUnreadBadge } from "@/components/chat/hooks/useChatUnreadBadge";

/** The hook only needs `on`/`off`; the SDK client is an EventEmitter. */
function fakeClient(): MatrixClient & EventEmitter {
  return new EventEmitter() as unknown as MatrixClient & EventEmitter;
}

const badgeCalls = () =>
  tauri.core.invoke.mock.calls.filter(([cmd]) => cmd === "chat_set_unread_badge").map(([, args]) => (args as { count: number }).count);

beforeEach(() => {
  tauri.reset();
  tauri.onInvoke("chat_set_unread_badge", () => undefined);
  rooms.count = 0;
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 16) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useChatUnreadBadge", () => {
  it("reports the attention count to Rust only when it changes", () => {
    const client = fakeClient();
    rooms.count = 3;
    renderHook(() => useChatUnreadBadge(client));
    expect(badgeCalls()).toEqual([3]);

    // A room event with the same count: no second IPC.
    act(() => {
      client.emit(RoomEvent.Timeline);
      vi.advanceTimersByTime(16);
    });
    expect(badgeCalls()).toEqual([3]);

    rooms.count = 5;
    act(() => {
      client.emit(RoomEvent.UnreadNotifications);
      vi.advanceTimersByTime(16);
    });
    expect(badgeCalls()).toEqual([3, 5]);
  });

  // Signing out of chat drops the client; the badge must not keep the last
  // number on the dock.
  it("resets to zero when the client goes away", () => {
    const client = fakeClient();
    rooms.count = 2;
    const { rerender } = renderHook(({ c }: { c: MatrixClient | null }) => useChatUnreadBadge(c), {
      initialProps: { c: client as MatrixClient | null },
    });
    expect(badgeCalls()).toEqual([2]);
    rerender({ c: null });
    expect(badgeCalls()).toEqual([2, 0]);
  });
});
