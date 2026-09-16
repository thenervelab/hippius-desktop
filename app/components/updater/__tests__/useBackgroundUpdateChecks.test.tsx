// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const listen = vi.hoisted(() => vi.fn());
const checkForUpdates = vi.hoisted(() => vi.fn());
const unlisten = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@/app/components/updater/checkForUpdates", () => ({ checkForUpdates }));

import {
  UPDATE_AVAILABLE_EVENT,
  useBackgroundUpdateChecks,
} from "../useBackgroundUpdateChecks";

/** Capture the handler the hook registers so a tick can be fired by hand. */
function armListener() {
  let fire: (() => void) | undefined;
  listen.mockImplementation((event: string, handler: () => void) => {
    if (event === UPDATE_AVAILABLE_EVENT) fire = handler;
    return Promise.resolve(unlisten);
  });
  return () => fire?.();
}

describe("useBackgroundUpdateChecks", () => {
  beforeEach(() => {
    listen.mockReset();
    checkForUpdates.mockReset();
    unlisten.mockReset();
    checkForUpdates.mockResolvedValue(undefined);
  });

  it("subscribes to the event Rust actually emits", () => {
    armListener();
    renderHook(() => useBackgroundUpdateChecks());

    // The string is a contract with `UPDATE_AVAILABLE_EVENT` in updates.rs;
    // a rename on one side alone is silent, and the symptom is the original
    // bug coming back.
    expect(listen).toHaveBeenCalledWith(
      "update://available",
      expect.any(Function),
    );
  });

  it("does nothing until the event fires", () => {
    armListener();
    renderHook(() => useBackgroundUpdateChecks());

    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it("runs the real presentation path when a release is announced", async () => {
    const fire = armListener();
    renderHook(() => useBackgroundUpdateChecks());

    fire();

    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
    // `true` is the non-blocking mode: this is not a button press, so it must
    // not sit waiting for an answer the way a user-initiated check does.
    expect(checkForUpdates).toHaveBeenCalledWith(true);
  });

  it("ignores a second announcement while the first is still running", async () => {
    let release: (() => void) | undefined;
    checkForUpdates.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const fire = armListener();
    renderHook(() => useBackgroundUpdateChecks());

    fire();
    fire();

    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
    release?.();
  });

  it("checks again once the previous run has finished", async () => {
    const fire = armListener();
    renderHook(() => useBackgroundUpdateChecks());

    fire();
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
    fire();
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(2));
  });

  it("a failed check does not wedge the listener", async () => {
    checkForUpdates.mockRejectedValueOnce(new Error("offline"));
    const fire = armListener();
    renderHook(() => useBackgroundUpdateChecks());

    fire();
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
    // Without the `finally`, one offline tick would leave the guard latched
    // and no later release would ever be shown.
    fire();
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(2));
  });

  it("unsubscribes on unmount", async () => {
    armListener();
    const { unmount } = renderHook(() => useBackgroundUpdateChecks());

    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalled());
  });
});
