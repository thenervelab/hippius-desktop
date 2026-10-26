import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

import { onTauriEvent, registerTauriListeners, safeUnlisten } from "../tauriListeners";

/** Let queued promise callbacks run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/** What Tauri's own unlisten throws when the listener's entry has not landed. */
const gapError = () => new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')");

describe("safeUnlisten", () => {
  afterEach(() => vi.useRealTimers());

  it("unlistens once however often it is called", async () => {
    const unlisten = vi.fn(async () => undefined);
    const stop = safeUnlisten(unlisten);
    stop();
    stop();
    await settle();
    stop();
    await settle();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  /**
   * The capture bar's Record: an unlisten that lands before Tauri's entry
   * rejected unhandled (the dev overlay's "listeners[eventId].handlerId")
   * and left the listener registered in Rust. It is tried again instead.
   */
  it("tries a refused unlisten again until Tauri takes it, without an unhandled rejection", async () => {
    vi.useFakeTimers();
    let landed = false;
    const unlisten = vi.fn(async () => {
      if (!landed) throw gapError();
    });
    safeUnlisten(unlisten)();
    await vi.advanceTimersByTimeAsync(0);
    expect(unlisten).toHaveBeenCalledTimes(1);
    landed = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(unlisten).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(unlisten).toHaveBeenCalledTimes(2);
  });

  it("gives up after a while on an unlisten that never succeeds", async () => {
    vi.useFakeTimers();
    const unlisten = vi.fn(() => {
      throw gapError();
    });
    safeUnlisten(unlisten)();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(unlisten).toHaveBeenCalledTimes(10);
  });
});

describe("onTauriEvent", () => {
  beforeEach(() => tauri.reset());

  it("delivers events until its cleanup, then none", async () => {
    const heard: unknown[] = [];
    const stop = onTauriEvent<number>("capture_mic_level", (e) => heard.push(e.payload));
    await stop.ready;
    await tauri.emitEvent("capture_mic_level", 1);
    stop();
    await settle();
    await tauri.emitEvent("capture_mic_level", 2);
    expect(heard).toEqual([1]);
  });

  /** StrictMode's mount, cleanup, mount: the first cleanup runs before `listen()` answers. */
  it("drops a listener cleaned up before listen() answered, once it answers", async () => {
    const heard: unknown[] = [];
    const stop = onTauriEvent<number>("capture_state_changed", (e) => heard.push(e.payload));
    stop();
    await stop.ready;
    await settle();
    await tauri.emitEvent("capture_state_changed", 1);
    expect(heard).toEqual([]);
  });

  it("is safe to clean up twice", async () => {
    const stop = onTauriEvent("capture_cameras", () => undefined);
    await stop.ready;
    stop();
    stop();
    await settle();
    await tauri.emitEvent("capture_cameras", []);
    expect(tauri.event.listen).toHaveBeenCalledTimes(1);
  });

  it("stays silent, then is dropped, when Tauri refuses the unlisten in its registration gap", async () => {
    const errors: unknown[] = [];
    const onRejection = (e: PromiseRejectionEvent | unknown) => errors.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      tauri.holdListenerEntries();
      // Count the unlistens Tauri took (the mock's answers `undefined` then).
      const realListen = tauri.event.listen.getMockImplementation()!;
      const dropped = vi.fn();
      tauri.event.listen.mockImplementationOnce(async (name: string, handler: (e: { payload: unknown }) => void) => {
        const unlisten = await realListen(name, handler);
        return () => {
          const answer = unlisten();
          if (answer === undefined) dropped();
          return answer;
        };
      });
      const heard: unknown[] = [];
      const stop = onTauriEvent<number>("capture_state_changed", (e) => heard.push(e.payload));
      await stop.ready;
      stop();
      await settle();
      // The entry lands: Rust still holds the listener, so it would hear
      // this, but the handler belongs to a cleaned-up effect.
      tauri.landListenerEntries();
      await tauri.emitEvent("capture_state_changed", 1);
      expect(heard).toEqual([]);
      // The retry, now that the entry is there, drops it for good.
      expect(dropped).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 150));
      expect(dropped).toHaveBeenCalledTimes(1);
      await tauri.emitEvent("capture_state_changed", 2);
      expect(heard).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("resolves ready, rather than rejecting, when the listener cannot be registered", async () => {
    tauri.event.listen.mockImplementationOnce(async () => {
      throw new Error("no IPC");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stop = onTauriEvent("capture_failed", () => undefined);
    await expect(stop.ready).resolves.toBeUndefined();
    stop();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("registerTauriListeners", () => {
  beforeEach(() => tauri.reset());

  it("cleans up without an unhandled rejection when Tauri refuses an unlisten", async () => {
    const errors: unknown[] = [];
    const onRejection = (e: unknown) => errors.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      tauri.holdListenerEntries();
      const { cleanup, ready } = registerTauriListeners([["sync_conflict", () => undefined]]);
      await ready;
      cleanup();
      cleanup();
      await settle();
      tauri.landListenerEntries();
      await new Promise((r) => setTimeout(r, 150));
      expect(errors).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
