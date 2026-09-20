import { renderHook } from "@testing-library/react";
import { EventEmitter } from "events";
import { type MatrixClient, type MatrixEvent, MatrixEventEvent, type Room, RoomEvent } from "matrix-js-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

// The Matrix-facts classifier has its own table test; here it is a seam
// so the hook's wiring (event → decrypt wait → IPC, open-room context)
// can be asserted directly.
const classify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/chat/notifications", () => ({ classifyIncoming: classify }));
vi.mock("@/lib/chat/rooms", () => ({ directRoomMap: () => new Map() }));

import { useChatNotifications } from "@/components/chat/hooks/useChatNotifications";

function fakeClient(): MatrixClient & EventEmitter {
  return new EventEmitter() as unknown as MatrixClient & EventEmitter;
}

function fakeEvent(opts: { encrypted?: boolean } = {}): MatrixEvent & EventEmitter {
  const e = new EventEmitter() as unknown as MatrixEvent & EventEmitter;
  Object.assign(e, {
    isBeingDecrypted: () => opts.encrypted ?? false,
    shouldAttemptDecryption: () => false,
  });
  return e;
}

const room = { roomId: "!g" } as unknown as Room;
const REPORT = { roomId: "!g", roomName: "#general", senderName: "bob", body: "hi", isDirect: false, isMention: true, roomIsOpen: false };

const notifyCalls = () => tauri.core.invoke.mock.calls.filter(([cmd]) => cmd === "chat_notify_message").map(([, args]) => args);

beforeEach(() => {
  tauri.reset();
  tauri.onInvoke("chat_notify_message", () => "shown");
  classify.mockReset();
  classify.mockReturnValue(REPORT);
});

describe("useChatNotifications", () => {
  it("hands a live timeline event to Rust and skips what the classifier rejects", () => {
    const client = fakeClient();
    renderHook(() => useChatNotifications(client, null));

    client.emit(RoomEvent.Timeline, fakeEvent(), room, false);
    expect(notifyCalls()).toEqual([{ message: REPORT }]);

    classify.mockReturnValue(null);
    client.emit(RoomEvent.Timeline, fakeEvent(), room, false);
    expect(notifyCalls()).toHaveLength(1);
  });

  it("ignores back-pagination and events without a room", () => {
    const client = fakeClient();
    renderHook(() => useChatNotifications(client, null));
    client.emit(RoomEvent.Timeline, fakeEvent(), room, true);
    client.emit(RoomEvent.Timeline, fakeEvent(), undefined, false);
    expect(classify).not.toHaveBeenCalled();
  });

  it("waits for decryption before classifying an encrypted event", () => {
    const client = fakeClient();
    renderHook(() => useChatNotifications(client, null));
    const event = fakeEvent({ encrypted: true });
    client.emit(RoomEvent.Timeline, event, room, false);
    expect(classify).not.toHaveBeenCalled();
    event.emit(MatrixEventEvent.Decrypted);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(notifyCalls()).toHaveLength(1);
  });

  it("passes the currently open room, read at event time, into the classifier", () => {
    const client = fakeClient();
    const { rerender } = renderHook(({ open }: { open: string | null }) => useChatNotifications(client, open), {
      initialProps: { open: null as string | null },
    });
    rerender({ open: "!g" });
    client.emit(RoomEvent.Timeline, fakeEvent(), room, false);
    expect(classify).toHaveBeenCalledWith(client, room, expect.anything(), expect.objectContaining({ openRoomId: "!g" }));
  });

  it("unsubscribes on unmount", () => {
    const client = fakeClient();
    const { unmount } = renderHook(() => useChatNotifications(client, null));
    unmount();
    client.emit(RoomEvent.Timeline, fakeEvent(), room, false);
    expect(classify).not.toHaveBeenCalled();
  });
});
