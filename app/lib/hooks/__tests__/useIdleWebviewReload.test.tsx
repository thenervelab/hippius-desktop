import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import {
  IDLE_RELOAD_CHECK_MS,
  pageIsBusy,
  useIdleWebviewReload,
} from "@/app/lib/hooks/useIdleWebviewReload";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// Rust decides when a long-unused webview is due (`webview_reload_due`); the
// page reloads only when told to, and never over an open dialog.
describe("useIdleWebviewReload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(invoke).mockReset();
  });

  async function tick() {
    await vi.advanceTimersByTimeAsync(IDLE_RELOAD_CHECK_MS);
  }

  it("reloads when Rust says it is due", async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    const reload = vi.fn();
    renderHook(() => useIdleWebviewReload(reload));
    await tick();
    expect(invoke).toHaveBeenCalledWith("webview_reload_due", { idleMs: IDLE_RELOAD_CHECK_MS });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Rust holds a reload of a window on screen while the page is in use, so
  // the page must report input, not only its age.
  it("reports the time since the last input, not since the page loaded", async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    renderHook(() => useIdleWebviewReload(vi.fn()));
    await vi.advanceTimersByTimeAsync(IDLE_RELOAD_CHECK_MS - 1000);
    window.dispatchEvent(new WheelEvent("wheel"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoke).toHaveBeenLastCalledWith("webview_reload_due", { idleMs: 1000 });
  });

  it("does nothing while it is not due", async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    const reload = vi.fn();
    renderHook(() => useIdleWebviewReload(reload));
    await tick();
    expect(reload).not.toHaveBeenCalled();
  });

  it("never reloads over an open dialog", async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    document.body.innerHTML = '<div role="dialog">Update available</div>';
    const reload = vi.fn();
    renderHook(() => useIdleWebviewReload(reload));
    await tick();
    expect(reload).not.toHaveBeenCalled();
  });

  it("treats any modal as busy", () => {
    document.body.innerHTML = '<div aria-modal="true"></div>';
    expect(pageIsBusy(document)).toBe(true);
    document.body.innerHTML = "<main></main>";
    expect(pageIsBusy(document)).toBe(false);
  });
});
