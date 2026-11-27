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
// page reports its input idle time and whether it is busy, and reloads when told to.
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
    expect(invoke).toHaveBeenCalledWith("webview_reload_due", {
      idleMs: IDLE_RELOAD_CHECK_MS,
      pageBusy: false,
    });
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
    expect(invoke).toHaveBeenLastCalledWith("webview_reload_due", { idleMs: 1000, pageBusy: false });
  });

  // A hidden tray popover re-renders on chat and link events; a re-render is
  // not the user, and must not reset the idle time or the interval.
  it("keeps counting idle time across re-renders of the host page", async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    const { rerender } = renderHook(() => useIdleWebviewReload());
    await vi.advanceTimersByTimeAsync(IDLE_RELOAD_CHECK_MS - 1000);
    rerender();
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoke).toHaveBeenLastCalledWith("webview_reload_due", {
      idleMs: IDLE_RELOAD_CHECK_MS,
      pageBusy: false,
    });
  });

  it("does nothing while it is not due", async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    const reload = vi.fn();
    renderHook(() => useIdleWebviewReload(reload));
    await tick();
    expect(reload).not.toHaveBeenCalled();
  });

  // Rust keeps a busy webview's clock running only when told it is busy.
  it("tells Rust a dialog is open, and never reloads over one", async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    document.body.innerHTML = '<div role="dialog">Delete this file?</div>';
    const reload = vi.fn();
    renderHook(() => useIdleWebviewReload(reload));
    await tick();
    expect(invoke).toHaveBeenCalledWith("webview_reload_due", {
      idleMs: IDLE_RELOAD_CHECK_MS,
      pageBusy: true,
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("skips the reload when the user came back while Rust was answering", async () => {
    let answer: (due: boolean) => void = () => undefined;
    vi.mocked(invoke).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const reload = vi.fn();
    renderHook(() => useIdleWebviewReload(reload));
    await tick();
    await vi.advanceTimersByTimeAsync(10);
    window.dispatchEvent(new Event("pointerdown"));
    answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).not.toHaveBeenCalled();
  });

  it("treats any modal as busy unless it is marked safe to reload over", () => {
    document.body.innerHTML = '<div aria-modal="true"></div>';
    expect(pageIsBusy(document)).toBe(true);
    document.body.innerHTML = '<div role="dialog" data-reload-safe=""></div>';
    expect(pageIsBusy(document)).toBe(false);
    document.body.innerHTML =
      '<div role="dialog" data-reload-safe=""></div><div role="alertdialog"></div>';
    expect(pageIsBusy(document)).toBe(true);
    document.body.innerHTML = "<main></main>";
    expect(pageIsBusy(document)).toBe(false);
  });

  // Six idle hours is long, but a reload in front of the user must not take a
  // half-written comment or chat message with it.
  it("treats unsent text in the focused field as busy, and nothing else", () => {
    document.body.innerHTML =
      '<textarea id="draft"></textarea><input id="search" /><input id="box" type="checkbox" />' +
      '<div id="composer" contenteditable="true"></div>';
    const focus = (id: string, fill: (el: HTMLElement) => void) => {
      const el = document.getElementById(id)!;
      fill(el);
      el.focus();
    };

    focus("draft", (el) => ((el as HTMLTextAreaElement).value = ""));
    expect(pageIsBusy(document)).toBe(false);
    focus("draft", (el) => ((el as HTMLTextAreaElement).value = "Looks good, but"));
    expect(pageIsBusy(document)).toBe(true);
    focus("search", (el) => ((el as HTMLInputElement).value = "invoice"));
    expect(pageIsBusy(document)).toBe(true);
    focus("box", (el) => ((el as HTMLInputElement).checked = true));
    expect(pageIsBusy(document)).toBe(false);
    focus("composer", (el) => (el.textContent = "hello"));
    expect(pageIsBusy(document)).toBe(true);
  });
});
