import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { CaptureOverlayContext } from "@/app/lib/tauri/capture";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

import CaptureOverlayPage from "../page";

const AREA = { x: 100, y: 100, width: 400, height: 300 };

const context = (over: Partial<CaptureOverlayContext> = {}): CaptureOverlayContext => ({
  mode: "area",
  displayId: 1,
  kind: "screenshot",
  windows: [],
  hostsBar: true,
  options: {
    timerSecs: 0,
    microphone: false,
    microphoneDevice: null,
    screen: true,
    camera: false,
    cameraDevice: null,
    cameraSize: "small",
    showClicks: false,
    systemAudio: false,
    lastKind: "screenshot",
    lastMode: "area",
    copyLink: true,
    recordCountdownSecs: 3,
  },
  countdownSecs: 0,
  recordingAvailable: true,
  recordingUnavailable: null,
  recordingUnavailableMessage: null,
  microphoneAvailable: true,
  showClicksAvailable: true,
  selection: "overlay",
  modes: { screenshot: ["area", "window", "screen"], recording: ["area", "window", "screen"] },
  screenshotTimer: true,
  systemAudio: true,
  microphoneUnavailableMessage: null,
  shortcut: { supported: true, via: "plugin", unavailableMessage: null },
  systemPickerNote: null,
  linuxSession: null,
  cameraOnlyAvailable: true,
  cameraFilmed: true,
  destination: { label: "Work", displayName: "Work" },
  pending: { target: "area", displayId: 1, rect: AREA },
  ...over,
});

let confirm: ReturnType<typeof vi.fn>;

function setup(over: Partial<CaptureOverlayContext> = {}) {
  tauri.onInvoke("capture_overlay_context", () => context(over));
  tauri.onInvoke("capture_camera_context", () => ({
    shape: null,
    hidden: false,
    deviceId: null,
    deviceName: null,
    size: "small",
    recording: false,
    cameraFilmed: true,
  }));
  tauri.onInvoke("capture_refresh_windows", () => []);
  tauri.onInvoke("capture_destination_choices", () => [{ label: "Work", remote: false }]);
  tauri.onInvoke("capture_cameras", () => []);
  tauri.onInvoke("capture_microphones", () => []);
  tauri.onInvoke("capture_set_pending", () => null);
  tauri.onInvoke("capture_cancel", () => null);
  tauri.onInvoke("capture_confirm", (args) => confirm(args));
  return render(<CaptureOverlayPage />);
}

const called = (cmd: string) => tauri.core.invoke.mock.calls.some(([c]) => c === cmd);

beforeEach(() => {
  tauri.reset();
  confirm = vi.fn(() => new Promise(() => undefined));
  window.history.replaceState({}, "", "/capture-overlay?display=1");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the capture overlay's keyboard", () => {
  it("takes the capture on Return", async () => {
    setup();
    await screen.findByRole("toolbar", { name: "Capture" });
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(confirm).toHaveBeenCalledWith({ displayId: 1 }));
  });

  // Return on a focused bar button is that button's: it must not also take
  // the capture.
  it("leaves Return on a focused bar button to the button", async () => {
    setup();
    const options = await screen.findByRole("button", { name: /Options/ });
    options.focus();
    fireEvent.keyDown(options, { key: "Enter" });
    expect(confirm).not.toHaveBeenCalled();
  });

  // Escape with a menu open used to cancel the whole capture.
  it("closes only the open menu on Escape, and gives focus back to its button", async () => {
    setup();
    const options = await screen.findByRole("button", { name: /Options/ });
    fireEvent.click(options);
    const menu = await screen.findByRole("menu", { name: "Capture options" });
    expect(menu).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(options).toHaveFocus();
    expect(called("capture_cancel")).toBe(false);
    // A second Escape closes the bar.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(called("capture_cancel")).toBe(true));
  });

  it("moves through an open menu with the arrow keys, Home and End", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /Options/ }));
    await screen.findByRole("menuitemradio", { name: /Work/ });
    // Every item, the radios and the copy-link checkbox, in menu order.
    const items = Array.from(
      screen.getByRole("menu", { name: "Capture options" }).querySelectorAll<HTMLElement>('[role^="menuitem"]'),
    );
    // Focus starts inside the menu, on a chosen item.
    expect(items).toContain(document.activeElement);
    expect(document.activeElement).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(window, { key: "Home" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(window, { key: "Home" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(window, { key: "End" });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(items[0]).toHaveFocus();
  });

  it("stops only the countdown on Escape", async () => {
    setup({ countdownSecs: 3 });
    await screen.findByRole("toolbar", { name: "Capture" });
    // Fake time only from here, so the count cannot tick on a slow machine.
    vi.useFakeTimers();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByText("Capturing in 3")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Capturing in 3")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(called("capture_cancel")).toBe(false);
    // The bar is back.
    expect(screen.getByRole("toolbar", { name: "Capture" })).toBeInTheDocument();
  });

  // Once the countdown has run out and Rust is taking the capture, Escape
  // cancels it, and a second Return does not start another countdown.
  it("cancels a capture that is already being taken", async () => {
    setup({ countdownSecs: 1 });
    await screen.findByRole("toolbar", { name: "Capture" });
    vi.useFakeTimers();
    fireEvent.keyDown(window, { key: "Enter" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(confirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    vi.useRealTimers();
    await waitFor(() => expect(called("capture_cancel")).toBe(true));
  });

  it("keeps a live region up before the count starts, for screen readers", async () => {
    const { container } = setup({ countdownSecs: 3 });
    await screen.findByRole("toolbar", { name: "Capture" });
    const region = container.querySelector('[aria-live="assertive"]');
    expect(region).toBeInTheDocument();
    expect(region).toBeEmptyDOMElement();
  });

  it("nudges the drawn area with the arrow keys, ten points with Shift", async () => {
    setup();
    await screen.findByRole("toolbar", { name: "Capture" });
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_pending", {
        selection: { target: "area", displayId: 1, rect: { ...AREA, x: 110 } },
      }),
    );
  });

  it("picks a mode with the arrow keys, as a radio group", async () => {
    tauri.onInvoke("capture_set_mode", () => null);
    setup();
    const group = await screen.findByRole("radiogroup", { name: "Screenshot" });
    const area = screen.getByRole("radio", { name: "Capture an area" });
    expect(area).toHaveAttribute("aria-checked", "true");
    expect(area).toHaveAttribute("tabindex", "0");
    area.focus();
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "Capture a window" })).toHaveFocus();
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_mode", { kind: "screenshot", mode: "window" }),
    );
  });
});

describe("the capture bar's words", () => {
  it("shows Record disabled with Rust's reason when this build has no helper, and does not switch to it", async () => {
    tauri.onInvoke("capture_set_mode", () => null);
    setup({
      recordingAvailable: false,
      cameraOnlyAvailable: false,
      recordingUnavailable: "helperMissing",
      recordingUnavailableMessage: "Screen recording isn't included in this build.",
    });
    const record = await screen.findByRole("radio", { name: "Record an area" });
    expect(record).toHaveAttribute("aria-disabled", "true");
    expect(record).toHaveAttribute("title", "Record an area: Screen recording isn't included in this build.");
    fireEvent.click(record);
    expect(screen.getByRole("status")).toHaveTextContent("Screen recording isn't included in this build.");
    expect(called("capture_set_mode")).toBe(false);
  });

  it("leaves Record out where the platform has no recorder", async () => {
    setup({
      recordingAvailable: false,
      cameraOnlyAvailable: false,
      recordingUnavailable: "unsupportedPlatform",
      recordingUnavailableMessage: "Screen recording isn't available on this system yet.",
    });
    await screen.findByRole("radio", { name: "Capture an area" });
    expect(screen.queryByRole("radio", { name: "Record an area" })).toBeNull();
  });

  it("names the Choose button for what it lists and says it opens a dialog", async () => {
    setup({ mode: "window", pending: null });
    const choose = await screen.findByRole("button", { name: "Choose window…" });
    expect(choose).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("keeps the Screen row's name when the screen is off, with a caption saying what that means", async () => {
    setup({
      kind: "recording",
      options: { ...context().options, screen: false, camera: true },
    });
    expect(await screen.findByRole("switch", { name: "Screen" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Recording the camera only")).toBeInTheDocument();
  });

  it("reads the cameras and microphones again when a device comes or goes, such as an iPhone waking nearby", async () => {
    const media = new EventTarget();
    Object.defineProperty(navigator, "mediaDevices", { value: media, configurable: true });
    try {
      setup({ kind: "recording" });
      await screen.findByRole("switch", { name: "Screen" });
      const count = (cmd: string) => tauri.core.invoke.mock.calls.filter(([c]) => c === cmd).length;
      await waitFor(() => expect(count("capture_microphones")).toBeGreaterThan(0));
      const cameras = count("capture_cameras");
      const microphones = count("capture_microphones");
      act(() => {
        media.dispatchEvent(new Event("devicechange"));
      });
      await waitFor(() => {
        expect(count("capture_cameras")).toBe(cameras + 1);
        expect(count("capture_microphones")).toBe(microphones + 1);
      });
    } finally {
      Reflect.deleteProperty(navigator, "mediaDevices");
    }
  });

  it("says why the microphone is off in Rust's words, on screen", async () => {
    setup({
      kind: "recording",
      microphoneAvailable: false,
      microphoneUnavailableMessage: "Recording the microphone needs macOS 15 or later",
    });
    expect(await screen.findByText("Recording the microphone needs macOS 15 or later")).toBeInTheDocument();
  });

  // The bar used to hard-code the macOS sentence, which a Windows user would
  // have read the moment Windows recording shipped.
  it("never names macOS for the microphone unless Rust does", async () => {
    setup({
      kind: "recording",
      microphoneAvailable: false,
      microphoneUnavailableMessage: "Recording the microphone isn't available on this system yet",
    });
    expect(await screen.findByText("Recording the microphone isn't available on this system yet")).toBeInTheDocument();
    expect(screen.queryByText(/macOS/)).toBeNull();
  });

  it("offers only the modes Rust offers", async () => {
    setup({ modes: { screenshot: ["area", "screen"], recording: ["screen"] } });
    await screen.findByRole("radio", { name: "Capture an area" });
    expect(screen.queryByRole("radio", { name: "Capture a window" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Record entire screen" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Record an area" })).toBeNull();
  });

  it("leaves the screenshot timer out where Rust says it is not offered", async () => {
    setup({ screenshotTimer: false });
    fireEvent.click(await screen.findByRole("button", { name: "Options" }));
    expect(await screen.findByRole("menu", { name: "Capture options" })).toBeInTheDocument();
    expect(screen.queryByText("Timer")).toBeNull();
    expect(screen.getByText("After capture")).toBeInTheDocument();
  });

  it("offers the screenshot timer where Rust says it is", async () => {
    setup({ screenshotTimer: true });
    fireEvent.click(await screen.findByRole("button", { name: "Options" }));
    expect(await screen.findByText("Timer")).toBeInTheDocument();
  });

  it("announces a refusal that replaces the hint", async () => {
    setup({ mode: "window", pending: null });
    const hint = await screen.findByRole("status");
    expect(hint).toHaveAttribute("aria-live", "polite");
    expect(hint).toHaveTextContent("Click a window to capture it");
  });
});

describe("the pending area across displays", () => {
  // Another display's restore raced this display's drag: its event cleared
  // this area, then this display's own event came last. Rust holds this
  // display's area, so it must be drawn again.
  it("draws its own area again when Rust says it holds it", async () => {
    setup();
    expect(await screen.findByText("400 × 300")).toBeInTheDocument();
    await act(() => tauri.emitEvent("capture_pending_changed", { displayId: 2, rect: { x: 0, y: 0, width: 50, height: 50 } }));
    expect(screen.queryByText("400 × 300")).toBeNull();
    await act(() => tauri.emitEvent("capture_pending_changed", { displayId: 1, rect: AREA }));
    expect(screen.getByText("400 × 300")).toBeInTheDocument();
  });
});

describe("skipping the countdown", () => {
  it("takes the capture at once on Return while counting", async () => {
    setup({ countdownSecs: 3 });
    await screen.findByRole("toolbar", { name: "Capture" });
    vi.useFakeTimers();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByText("Capturing in 3")).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    // The count that was left never fires a second capture.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("takes the capture at once when the number is clicked", async () => {
    setup({ countdownSecs: 5 });
    await screen.findByRole("toolbar", { name: "Capture" });
    vi.useFakeTimers();
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Capture now" })).toBeNull();
  });
});

describe("the Options menu", () => {
  const saved = (options: CaptureOverlayContext["options"], countdownSecs: number) => ({
    options,
    countdownSecs,
    cameraFilmed: true,
  });

  it("offers a recording countdown, and the overlay counts what Rust says", async () => {
    tauri.onInvoke("capture_set_options", (args) => {
      const { options } = args as { options: CaptureOverlayContext["options"] };
      return saved(options, options.recordCountdownSecs);
    });
    setup({ kind: "recording", countdownSecs: 3 });
    fireEvent.click(await screen.findByRole("button", { name: /Options/ }));
    const five = await screen.findByRole("menuitemradio", { name: "5 seconds" });
    expect(screen.getByRole("menuitemradio", { name: "3 seconds" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "None" })).toBeInTheDocument();
    fireEvent.click(five);
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_options", {
        options: expect.objectContaining({ recordCountdownSecs: 5 }),
      }),
    );
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "5 seconds" })).toHaveAttribute("aria-checked", "true"));
    fireEvent.keyDown(window, { key: "Escape" });
    vi.useFakeTimers();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByText("Recording in 5")).toBeInTheDocument();
  });

  it("offers system audio for a recording, off until asked for", async () => {
    tauri.onInvoke("capture_set_options", (args) => saved((args as { options: CaptureOverlayContext["options"] }).options, 3));
    setup({ kind: "recording", countdownSecs: 3 });
    fireEvent.click(await screen.findByRole("button", { name: /Options/ }));
    const system = await screen.findByRole("menuitemcheckbox", { name: "Record system audio" });
    expect(system).toHaveAttribute("aria-checked", "false");
    fireEvent.click(system);
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_options", {
        options: expect.objectContaining({ systemAudio: true }),
      }),
    );
  });

  it("offers no system audio where Rust says this platform cannot record it", async () => {
    setup({ kind: "recording", countdownSecs: 3, systemAudio: false });
    fireEvent.click(await screen.findByRole("button", { name: /Options/ }));
    await screen.findByRole("menuitemradio", { name: "3 seconds" });
    expect(screen.queryByRole("menuitemcheckbox", { name: "Record system audio" })).toBeNull();
  });

  it("offers no system audio for a screenshot", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /Options/ }));
    await screen.findByRole("menu", { name: "Capture options" });
    expect(screen.queryByRole("menuitemcheckbox", { name: "Record system audio" })).toBeNull();
  });

  it("turns copying a share link after capture on and off", async () => {
    tauri.onInvoke("capture_set_options", (args) => saved((args as { options: CaptureOverlayContext["options"] }).options, 0));
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /Options/ }));
    const copy = await screen.findByRole("menuitemcheckbox", { name: "Copy a share link after capture" });
    expect(copy).toHaveAttribute("aria-checked", "true");
    fireEvent.click(copy);
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_options", {
        options: expect.objectContaining({ copyLink: false }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("menuitemcheckbox", { name: "Copy a share link after capture" })).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
  });
});

describe("the recording sources", () => {
  it("says when a window recording leaves the camera out", async () => {
    setup({ kind: "recording", mode: "window", pending: null, cameraFilmed: false });
    expect(await screen.findByText("Camera is only recorded with the entire screen or an area.")).toBeInTheDocument();
  });

  it("says nothing about the camera when it is filmed", async () => {
    setup({ kind: "recording" });
    await screen.findByRole("group", { name: "Recording sources" });
    expect(screen.queryByText("Camera is only recorded with the entire screen or an area.")).toBeNull();
  });

  it("offers camera only (the Screen switch) only where Rust can record it", async () => {
    setup({ kind: "recording", cameraOnlyAvailable: false });
    await screen.findByRole("group", { name: "Recording sources" });
    expect(screen.queryByRole("switch", { name: "Screen" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Camera" })).toBeInTheDocument();
  });
});

describe("window mode's live window list", () => {
  const refreshes = () => tauri.core.invoke.mock.calls.filter(([c]) => c === "capture_refresh_windows").length;

  it("asks Rust for this display's windows while in window mode, and stops when the mode changes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup({ mode: "window", pending: null });
    await screen.findByRole("toolbar", { name: "Capture" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(refreshes()).toBeGreaterThanOrEqual(1);
    expect(tauri.core.invoke).toHaveBeenCalledWith("capture_refresh_windows", { displayId: 1 });

    tauri.onInvoke("capture_overlay_context", () => context({ mode: "area" }));
    await act(() => tauri.emitEvent("capture_state_changed", { phase: "selecting", kind: "screenshot", mode: "area", seq: 2 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const after = refreshes();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(refreshes()).toBe(after);
  });

  it("does not poll outside window mode", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    await screen.findByRole("toolbar", { name: "Capture" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(refreshes()).toBe(0);
  });
});

// jsdom has no PointerEvent, and without one a pointer event loses its
// coordinates; a MouseEvent carries them.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventWithCoords extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  Object.defineProperty(window, "PointerEvent", { value: PointerEventWithCoords, configurable: true });
}

describe("click to capture", () => {
  const FINDER = { id: 11, appName: "Finder", title: "Downloads", x: 0, y: 0, width: 300, height: 200 };
  const SAFARI = { id: 22, appName: "Safari", title: "News", x: 400, y: 0, width: 300, height: 200 };
  const surface = (container: HTMLElement) => container.firstElementChild as HTMLElement;
  const move = (el: HTMLElement, x: number, y: number) => fireEvent.pointerMove(el, { clientX: x, clientY: y });
  const click = (el: HTMLElement, x: number, y: number) => {
    fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0 });
    fireEvent.pointerUp(el, { clientX: x, clientY: y, button: 0 });
  };

  beforeEach(() => {
    tauri.onInvoke("capture_select", () => new Promise(() => undefined));
    tauri.onInvoke("capture_set_mode", () => null);
  });

  it("shows the camera cursor for a screenshot and the record-dot camera for a recording", async () => {
    const shot = setup({ mode: "window", pending: null, windows: [FINDER] });
    await screen.findByRole("toolbar", { name: "Capture" });
    const shotCursor = surface(shot.container).style.cursor;
    expect(shotCursor).toContain("data:image/svg+xml");
    expect(shotCursor).not.toContain("FF453A");
    shot.unmount();

    const rec = setup({ kind: "recording", mode: "window", pending: null, windows: [FINDER] });
    await screen.findByRole("toolbar", { name: "Capture" });
    expect(surface(rec.container).style.cursor).toContain("FF453A");
  });

  it("lights the window under the pointer, following it, and one click takes that window", async () => {
    const { container } = setup({ mode: "window", pending: null, windows: [FINDER, SAFARI] });
    await screen.findByRole("toolbar", { name: "Capture" });
    const el = surface(container);
    move(el, 50, 50);
    expect(await screen.findByText("Finder")).toBeInTheDocument();
    move(el, 450, 50);
    expect(await screen.findByText("Safari")).toBeInTheDocument();
    expect(screen.queryByText("Finder")).toBeNull();
    click(el, 450, 50);
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_select", { selection: { target: "window", windowId: 22 } }),
    );
    // No need to press the bar's button as well.
    expect(confirm).not.toHaveBeenCalled();
  });

  it("takes nothing for a click where no window is", async () => {
    const { container } = setup({ mode: "window", pending: null, windows: [FINDER] });
    await screen.findByRole("toolbar", { name: "Capture" });
    click(surface(container), 900, 500);
    expect(called("capture_select")).toBe(false);
  });

  it("still counts down the screenshot timer after the click", async () => {
    const { container } = setup({ mode: "window", pending: null, windows: [FINDER], countdownSecs: 5 });
    await screen.findByRole("toolbar", { name: "Capture" });
    click(surface(container), 50, 50);
    expect(screen.getByText("Capturing in 5")).toBeInTheDocument();
    expect(called("capture_select")).toBe(false);
  });

  it("cancels on Escape", async () => {
    setup({ mode: "window", pending: null, windows: [FINDER] });
    await screen.findByRole("toolbar", { name: "Capture" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(called("capture_cancel")).toBe(true));
  });

  it("switches between window and area on Space, as macOS does", async () => {
    setup({ mode: "window", pending: null, windows: [FINDER] });
    await screen.findByRole("toolbar", { name: "Capture" });
    expect(screen.getByRole("status")).toHaveTextContent("press Space to drag an area");
    fireEvent.keyDown(window, { key: " " });
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_mode", { kind: "screenshot", mode: "area" }),
    );
  });

  it("switches from area to window on Space", async () => {
    setup({ mode: "area" });
    await screen.findByRole("toolbar", { name: "Capture" });
    fireEvent.keyDown(window, { key: " " });
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_mode", { kind: "screenshot", mode: "window" }),
    );
  });

  it("does not switch to a mode Rust does not offer on this platform", async () => {
    setup({
      mode: "window",
      pending: null,
      windows: [FINDER],
      modes: { screenshot: ["window", "screen"], recording: ["area", "window", "screen"] },
    });
    await screen.findByRole("toolbar", { name: "Capture" });
    fireEvent.keyDown(window, { key: " " });
    expect(called("capture_set_mode")).toBe(false);
    expect(screen.getByRole("status")).not.toHaveTextContent("Space");
  });

  it("leaves Space on a focused bar button to the button", async () => {
    setup({ mode: "window", pending: null, windows: [FINDER] });
    const options = await screen.findByRole("button", { name: /Options/ });
    options.focus();
    fireEvent.keyDown(options, { key: " " });
    expect(called("capture_set_mode")).toBe(false);
  });

  it("lights nothing while the pointer is over the capture bar", async () => {
    const { container } = setup({ mode: "window", pending: null, windows: [FINDER] });
    await screen.findByRole("toolbar", { name: "Capture" });
    move(surface(container), 50, 50);
    expect(await screen.findByText("Finder")).toBeInTheDocument();
    fireEvent.pointerOver(screen.getByRole("toolbar", { name: "Capture" }));
    await waitFor(() => expect(screen.queryByText("Finder")).toBeNull());
    expect(screen.getByTestId("capture-bar-slot").style.cursor).toBe("default");
  });

  it("captures the display under the pointer with one click in entire-screen mode", async () => {
    const { container } = setup({ mode: "screen", pending: null });
    await screen.findByRole("toolbar", { name: "Capture" });
    const el = surface(container);
    expect(el.style.cursor).toContain("data:image/svg+xml");
    move(el, 300, 300);
    expect(await screen.findByText("Click to capture this screen")).toBeInTheDocument();
    click(el, 300, 300);
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_select", { selection: { target: "screen", displayId: 1 } }),
    );
  });

  // Return goes through Rust, which takes the display under the pointer.
  it("asks Rust to take the screen on Return", async () => {
    setup({ mode: "screen", pending: null });
    await screen.findByRole("toolbar", { name: "Capture" });
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(confirm).toHaveBeenCalledWith({ displayId: 1 }));
  });

  it("does not toggle on Space in entire-screen mode", async () => {
    setup({ mode: "screen", pending: null });
    await screen.findByRole("toolbar", { name: "Capture" });
    fireEvent.keyDown(window, { key: " " });
    expect(called("capture_set_mode")).toBe(false);
  });
});
