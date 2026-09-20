import { act, renderHook } from "@testing-library/react";
import { EventEmitter } from "events";
import { type MatrixClient, MatrixEventEvent, RoomEvent } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useClientTick } from "@/components/chat/hooks/useClientTick";

/** The hook only needs `on`/`off`; the SDK client is an EventEmitter. */
function fakeClient(): MatrixClient & EventEmitter {
  return new EventEmitter() as unknown as MatrixClient & EventEmitter;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 16) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useClientTick", () => {
  it("bumps once per frame for the client-level Decrypted re-emit, including retries", () => {
    const client = fakeClient();
    const { result } = renderHook(() => useClientTick(client, [RoomEvent.Timeline, MatrixEventEvent.Decrypted]));
    expect(result.current).toBe(0);

    // First decryption attempt fails, the key arrives, the retry succeeds:
    // the client re-emits both, from the same event object.
    act(() => {
      client.emit(MatrixEventEvent.Decrypted, {}, new Error("no key"));
      client.emit(MatrixEventEvent.Decrypted, {});
      vi.advanceTimersByTime(16);
    });
    expect(result.current).toBe(1);

    act(() => {
      client.emit(MatrixEventEvent.Decrypted, {});
      vi.advanceTimersByTime(16);
    });
    expect(result.current).toBe(2);
  });

  it("stops listening on unmount", () => {
    const client = fakeClient();
    const { unmount } = renderHook(() => useClientTick(client, [MatrixEventEvent.Decrypted]));
    expect(client.listenerCount(MatrixEventEvent.Decrypted)).toBe(1);
    unmount();
    expect(client.listenerCount(MatrixEventEvent.Decrypted)).toBe(0);
  });
});
