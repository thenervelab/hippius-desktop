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
    openLink: true,
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
  recordCountdown: true,
  systemAudio: true,
  microphoneUnavailableMessage: null,
  continuityHint: null,
  shortcut: { supported: true, via: "plugin", unavailableMessage: null },
  systemPickerNote: null,
  linuxSession: null,
  cameraOnlyAvailable: true,
  cameraFilmed: true,
  destination: { label: "Work", displayName: "Work" },
  pending: { target: "area", displayId: 1, rect: AREA },
  instant: false,
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
    recorderOwnsCamera: false,
  }));
  tauri.onInvoke("capture_refresh_windows", () => []);
  tauri.onInvoke("capture_cameras", () => []);
  tauri.onInvoke("capture_microphones", () => []);
  tauri.onInvoke("capture_set_pending", () => null);
  tauri.onInvoke("capture_hold_bar", () => null);
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

  // The key arrives the moment the bar is in the DOM, before React has run
  // the page's passive effects: a listener bound in a `useEffect` still held
  // the first render's closure (no context yet) and dropped the Return. A
  // MutationObserver callback is a microtask, so it runs ahead of those
  // effects, which React schedules as a later task.
  it("takes the capture on a Return pressed as soon as the bar appears", async () => {
    const observer = new MutationObserver(() => {
      if (!screen.queryByRole("toolbar", { name: "Capture" })) return;
      observer.disconnect();
      fireEvent.keyDown(window, { key: "Enter" });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      setup();
      await waitFor(() => expect(confirm).toHaveBeenCalledWith({ displayId: 1 }));
    } finally {
      observer.disconnect();
    }
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
    // Where captures go is said, not chosen, here: the captures drive.
    expect(await screen.findByTestId("capture-save-to")).toHaveTextContent("Work");
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

  // Rust moves the bar to the display the pointer settles on, unless the
  // bar's overlay holds it: a countdown would be lost on the way.
  it("holds the bar on its display while counting down, and lets it follow again after", async () => {
    setup({ countdownSecs: 3 });
    await screen.findByRole("toolbar", { name: "Capture" });
    const holds = () =>
      tauri.core.invoke.mock.calls.filter(([c]) => c === "capture_hold_bar").map(([, args]) => args);
    await waitFor(() => expect(holds()).toEqual([{ held: false }]));
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(holds().at(-1)).toEqual({ held: true }));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(holds().at(-1)).toEqual({ held: false }));
  });

  it("does not hold a bar it does not draw", async () => {
    setup({ hostsBar: false });
    await waitFor(() => expect(called("capture_overlay_context")).toBe(true));
    // Let the context land and the page's effects run.
    await act(async () => {});
    expect(called("capture_hold_bar")).toBe(false);
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

  // Windows gives a desktop app no prompt: a switched-off privacy setting
  // just keeps the device shut, so the row says so and opens the page.
  it("offers Open Settings under a microphone Windows blocks, for that device only", async () => {
    const line = "Windows is blocking the microphone. Turn on microphone access for desktop apps in Settings, Privacy & security, Microphone.";
    tauri.onInvoke("capture_open_privacy_settings", () => null);
    setup({
      kind: "recording",
      microphoneAvailable: false,
      microphoneUnavailableMessage: line,
      privacyBlocked: { microphone: true, camera: false },
      cameraUnavailableMessage: null,
    });
    expect(await screen.findByText(line, { exact: false })).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "Open Settings" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_open_privacy_settings", { device: "microphone" }),
    );
  });

  it("says a blocked camera is blocked in Rust's words, with its own Open Settings", async () => {
    const line = "Windows is blocking the camera. Turn on camera access for desktop apps in Settings, Privacy & security, Camera.";
    tauri.onInvoke("capture_open_privacy_settings", () => null);
    setup({
      kind: "recording",
      privacyBlocked: { microphone: false, camera: true },
      cameraUnavailableMessage: line,
    });
    expect(await screen.findByText(line, { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_open_privacy_settings", { device: "camera" }),
    );
  });

  it("offers no Open Settings where nothing is blocked", async () => {
    setup({ kind: "recording" });
    await screen.findByRole("switch", { name: "Screen" });
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
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
    // Return counts down only once the area has loaded, which lands after
    // the toolbar; on a loaded runner it had not yet.
    await screen.findByText("400 × 300");
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
    // Return counts down only once the area has loaded, which lands after
    // the toolbar; on a loaded runner it had not yet.
    await screen.findByText("400 × 300");
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

  // As Zight does: the link it just copied opens in the browser, unless
  // turned off. Offered only while links are made at all.
  it("turns opening the link in the browser on and off, only while links are copied", async () => {
    tauri.onInvoke("capture_set_options", (args) => saved((args as { options: CaptureOverlayContext["options"] }).options, 0));
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /Options/ }));
    const open = await screen.findByRole("menuitemcheckbox", { name: "Open the link in your browser" });
    expect(open).toHaveAttribute("aria-checked", "true");
    fireEvent.click(open);
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_options", {
        options: expect.objectContaining({ openLink: false }),
      }),
    );
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Copy a share link after capture" }));
    await waitFor(() => expect(screen.queryByRole("menuitemcheckbox", { name: "Open the link in your browser" })).toBeNull());
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

  // The Record menu's "Entire screen": the bar, its sources and the screen
  // hint, whatever the address says. Only Rust's `instant` hides the bar
  // (the shortcut's one-step screenshot), so a stray `instant=1` cannot.
  it("records the entire screen from the bar: the bar is up, then one click counts down and takes it", async () => {
    window.history.replaceState({}, "", "/capture-overlay?display=1&instant=1");
    const { container } = setup({ kind: "recording", mode: "screen", pending: null, countdownSecs: 3, instant: false });
    await screen.findByRole("toolbar", { name: "Capture" });
    expect(screen.queryByTestId("capture-instant-hint")).toBeNull();
    expect(screen.getByRole("button", { name: /^Microphone:/ })).toBeInTheDocument();
    const el = surface(container);
    move(el, 300, 300);
    expect(await screen.findByText("Click to record this screen")).toBeInTheDocument();
    vi.useFakeTimers();
    click(el, 300, 300);
    expect(screen.getByText("Recording in 3")).toBeInTheDocument();
    expect(called("capture_select")).toBe(false);
    // One second per number; each re-render arms the next.
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(tauri.core.invoke).toHaveBeenCalledWith("capture_select", { selection: { target: "screen", displayId: 1 } });
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

describe("the camera and microphone menus", () => {
  const HINT = "iPhone not listed? Keep it close by, signed in to the same Apple Account, with Wi-Fi and Bluetooth on. It can take a few seconds to appear.";
  const BUILT_IN = { id: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", isDefault: true, continuity: false };
  const PHONE_MIC = { id: "iPhoneMic-UID", name: "Ahmad\u2019s iPhone Microphone", isDefault: false, continuity: true };
  const recording = { kind: "recording" as const, continuityHint: HINT };

  const openMicrophones = async () => {
    fireEvent.click(await screen.findByRole("button", { name: /^Microphone:/ }));
    return screen.findByRole("menu", { name: "Choose a microphone" });
  };

  // An iPhone's microphone reaches the Mac after its camera, often after the
  // menu was read. Rust's watcher sends the new list; the open menu takes it.
  it("adds a phone microphone Rust reports after the menu was read, and drops the iPhone hint", async () => {
    setup(recording);
    tauri.onInvoke("capture_microphones", () => [BUILT_IN]);
    const menu = await openMicrophones();
    await waitFor(() => expect(menu).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByRole("menuitemradio", { name: /MacBook Pro Microphone/ })).toBeInTheDocument();
    expect(screen.getByText(HINT)).toBeInTheDocument();

    await act(() => tauri.emitEvent("capture_microphones", [BUILT_IN, PHONE_MIC]));
    expect(await screen.findByRole("menuitemradio", { name: /iPhone Microphone/ })).toBeInTheDocument();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("records from the microphone picked: its system id is what is saved", async () => {
    tauri.onInvoke("capture_set_options", (args) => ({
      options: (args as { options: CaptureOverlayContext["options"] }).options,
      countdownSecs: 3,
      cameraFilmed: true,
    }));
    setup(recording);
    tauri.onInvoke("capture_microphones", () => [BUILT_IN, PHONE_MIC]);
    await openMicrophones();
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /iPhone Microphone/ }));
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_options", {
        options: expect.objectContaining({ microphone: true, microphoneDevice: "iPhoneMic-UID" }),
      }),
    );
  });

  it("shows placeholders, not an empty menu, until the first list arrives", async () => {
    setup(recording);
    tauri.onInvoke("capture_microphones", () => new Promise(() => undefined));
    const menu = await openMicrophones();
    expect(menu).toHaveAttribute("aria-busy", "true");
    expect(menu.querySelectorAll("[data-device-skeleton]").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Only the default microphone/)).toBeNull();
    expect(screen.getByText("Looking for microphones")).toBeInTheDocument();
  });

  it("gives no iPhone hint where Rust has none (Windows, Linux)", async () => {
    setup({ kind: "recording", continuityHint: null });
    tauri.onInvoke("capture_microphones", () => [BUILT_IN]);
    const menu = await openMicrophones();
    await waitFor(() => expect(menu).toHaveAttribute("aria-busy", "false"));
    expect(screen.queryByText(/iPhone not listed/)).toBeNull();
  });

  it("gives the same hint under the camera menu while no iPhone camera is listed", async () => {
    setup(recording);
    tauri.onInvoke("capture_cameras", () => [{ id: "1F06", name: "FaceTime HD Camera", isDefault: true }]);
    fireEvent.click(await screen.findByRole("button", { name: /^Camera:/ }));
    const menu = await screen.findByRole("menu", { name: "Choose a camera" });
    await waitFor(() => expect(menu).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });
});

/** Rust's context for the Wayland recording panel (`selection: systemPicker`). */
const PANEL: Partial<CaptureOverlayContext> = {
  kind: "recording",
  mode: "window",
  displayId: 0,
  selection: "systemPicker",
  modes: { screenshot: [], recording: ["window", "screen"] },
  screenshotTimer: false,
  recordCountdown: false,
  systemPickerNote: "Your desktop's screenshot tool opens, so you can choose an area, a window or a whole screen there.",
  linuxSession: "wayland",
  cameraOnlyAvailable: false,
  pending: null,
};

describe("the recording panel where the desktop's dialog chooses (Wayland)", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/capture-overlay?display=0");
  });

  it("is the bar alone in a panel, with no selection surface and no list of windows", async () => {
    setup(PANEL);
    const toolbar = await screen.findByRole("toolbar", { name: "Capture" });
    // The bar's own empty parts move the window: there is nothing else in it.
    expect(toolbar).toHaveAttribute("data-tauri-drag-region");
    expect(screen.queryByRole("button", { name: /Choose (window|screen)/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /Capture/ })).toBeNull();
    expect(screen.getByRole("radio", { name: "Record a window" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Record entire screen" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("then choose a window in your desktop's sharing dialog");
  });

  /** No window to click there: Record goes on to Rust, which asks the desktop. */
  it("records a window without asking for a click", async () => {
    setup(PANEL);
    fireEvent.click(await screen.findByRole("button", { name: "Record" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith({ displayId: 0 }));
    expect(screen.queryByText(/Click a window/)).toBeNull();
  });

  it("takes Return as Record and never polls for windows", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup(PANEL);
    await screen.findByRole("toolbar", { name: "Capture" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(called("capture_refresh_windows")).toBe(false);
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(confirm).toHaveBeenCalledWith({ displayId: 0 }));
  });

  it("offers no countdown, since the desktop's dialog comes first", async () => {
    setup(PANEL);
    fireEvent.click(await screen.findByRole("button", { name: /Options/ }));
    await screen.findByRole("menu", { name: "Capture options" });
    expect(screen.queryByText("Recording countdown")).toBeNull();
    expect(screen.getByText("Record system audio")).toBeInTheDocument();
  });

  /**
   * The panel used to draw a 520 x 600 box of dark glass with a border
   * behind the bar, which on a Wayland desktop was a big dark frame around a
   * small bar. Now nothing but the bar is drawn, and the window is fitted to
   * it: grown below the bar when a menu opens, shrunk back when it closes.
   */
  it("draws only the bar and fits its window to the bar and an open menu", async () => {
    const fits: Array<{ width: number; height: number }> = [];
    tauri.onInvoke("capture_panel_fit", (args) => {
      fits.push(args as { width: number; height: number });
      return null;
    });
    const real = HTMLElement.prototype.getBoundingClientRect;
    // jsdom lays nothing out: the bar is 480 x 200 at the panel's 12 px
    // inset, and a menu hangs 150 px below it.
    const box = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "capture-panel") return box(12, 12, 480, 200);
      if (this.getAttribute("role") === "menu") return box(236, 222, 256, 140);
      return real.call(this);
    });
    try {
      setup(PANEL);
      await screen.findByRole("toolbar", { name: "Capture" });
      const panel = screen.getByTestId("capture-panel");
      // No glass, frame or rounding of the panel's own around the bar.
      expect(panel.className).not.toMatch(/bg-|border|rounded/);
      expect(panel).not.toHaveAttribute("data-tauri-drag-region");
      await waitFor(() => expect(fits).toContainEqual({ width: 504, height: 224 }));

      fireEvent.click(screen.getByRole("button", { name: /Options/ }));
      await screen.findByRole("menu", { name: "Capture options" });
      await waitFor(() => expect(fits.at(-1)).toEqual({ width: 504, height: 374 }));

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu", { name: "Capture options" })).toBeNull());
      await waitFor(() => expect(fits.at(-1)).toEqual({ width: 504, height: 224 }));
    } finally {
      spy.mockRestore();
    }
  });

  /** A full-screen overlay is not fitted to anything. */
  it("never fits an overlay", async () => {
    window.history.replaceState({}, "", "/capture-overlay?display=1");
    setup();
    await screen.findByRole("toolbar", { name: "Capture" });
    fireEvent.click(screen.getByRole("button", { name: /Options/ }));
    await screen.findByRole("menu", { name: "Capture options" });
    expect(called("capture_panel_fit")).toBe(false);
  });

  it("says what Record leads to for a whole screen", async () => {
    setup({ ...PANEL, mode: "screen" });
    expect(await screen.findByRole("status")).toHaveTextContent("then choose a screen in your desktop's sharing dialog");
  });
});

describe("the shortcut's one-step area screenshot", () => {
  const INSTANT = { instant: true, pending: null } as const;
  const surface = (container: HTMLElement) => container.firstElementChild as HTMLElement;
  const at = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0 });

  beforeEach(() => {
    tauri.onInvoke("capture_select", () => new Promise(() => undefined));
    tauri.onInvoke("capture_set_mode", () => null);
    window.history.replaceState({}, "", "/capture-overlay?display=1&instant=1");
    try {
      localStorage.setItem("hippius:capture-last-area", JSON.stringify({ displayId: 1, rect: AREA }));
    } catch {
      // jsdom always has storage; the guard matches the page's own.
    }
  });

  afterEach(() => {
    try {
      localStorage.removeItem("hippius:capture-last-area");
    } catch {
      // see above
    }
  });

  it("shows a crosshair with no bar and nothing drawn, only a line saying what to do", async () => {
    const { container } = setup(INSTANT);
    const hint = await screen.findByTestId("capture-instant-hint");
    expect(hint).toHaveTextContent("Drag to capture an area");
    expect(hint).toHaveTextContent("Esc to cancel");
    expect(screen.queryByRole("toolbar", { name: "Capture" })).toBeNull();
    expect(surface(container).style.cursor).toBe("crosshair");
    // The last area is not brought back, and nothing is handed to Rust.
    expect(screen.queryByText(/400 × 300|400 x 300/)).toBeNull();
    expect(called("capture_set_pending")).toBe(false);
  });

  it("is a crosshair before Rust has answered", async () => {
    tauri.onInvoke("capture_overlay_context", () => new Promise(() => undefined));
    render(<CaptureOverlayPage />);
    expect(await screen.findByTestId("capture-instant-pending")).toHaveStyle({ cursor: "crosshair" });
  });

  it("takes the area the moment the drag ends, with no button to press", async () => {
    const { container } = setup(INSTANT);
    await screen.findByTestId("capture-instant-hint");
    const el = surface(container);
    fireEvent.pointerDown(el, at(10, 20));
    fireEvent.pointerMove(el, at(210, 120));
    fireEvent.pointerUp(el, at(210, 120));
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_select", {
        selection: { target: "area", displayId: 1, rect: { x: 10, y: 20, width: 200, height: 100 } },
      }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(called("capture_set_pending")).toBe(false);
  });

  it("takes nothing for a click without a drag", async () => {
    const { container } = setup(INSTANT);
    await screen.findByTestId("capture-instant-hint");
    const el = surface(container);
    fireEvent.pointerDown(el, at(50, 50));
    fireEvent.pointerUp(el, at(50, 50));
    expect(called("capture_select")).toBe(false);
  });

  it("moves the area being dragged while Space is held, as macOS does", async () => {
    const { container } = setup(INSTANT);
    await screen.findByTestId("capture-instant-hint");
    const el = surface(container);
    fireEvent.pointerDown(el, at(10, 10));
    fireEvent.pointerMove(el, at(110, 60));
    fireEvent.keyDown(window, { key: " " });
    fireEvent.pointerMove(el, at(160, 90));
    fireEvent.pointerUp(el, at(160, 90));
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_select", {
        selection: { target: "area", displayId: 1, rect: { x: 60, y: 40, width: 100, height: 50 } },
      }),
    );
    // Space while dragging moves; it does not switch to window mode.
    expect(called("capture_set_mode")).toBe(false);
  });

  it("goes back to growing the area when Space is let go", async () => {
    const { container } = setup(INSTANT);
    await screen.findByTestId("capture-instant-hint");
    const el = surface(container);
    fireEvent.pointerDown(el, at(10, 10));
    fireEvent.pointerMove(el, at(110, 60));
    fireEvent.keyDown(window, { key: " " });
    fireEvent.pointerMove(el, at(160, 90));
    fireEvent.keyUp(window, { key: " " });
    fireEvent.pointerMove(el, at(260, 190));
    fireEvent.pointerUp(el, at(260, 190));
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_select", {
        selection: { target: "area", displayId: 1, rect: { x: 60, y: 40, width: 200, height: 150 } },
      }),
    );
  });

  it("cancels on Escape", async () => {
    setup(INSTANT);
    await screen.findByTestId("capture-instant-hint");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(called("capture_cancel")).toBe(true));
  });

  it("switches to clicking a window on Space before a drag, still without a bar", async () => {
    setup(INSTANT);
    expect(await screen.findByTestId("capture-instant-hint")).toHaveTextContent("press Space for a window");
    fireEvent.keyDown(window, { key: " " });
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_mode", { kind: "screenshot", mode: "window" }),
    );
  });

  it("says how to get back to an area in window mode", async () => {
    setup({ ...INSTANT, mode: "window", windows: [] });
    expect(await screen.findByTestId("capture-instant-hint")).toHaveTextContent("Space to drag an area");
    expect(screen.queryByRole("toolbar", { name: "Capture" })).toBeNull();
  });

  it("draws no hint on the displays that do not host it", async () => {
    setup({ ...INSTANT, hostsBar: false });
    await waitFor(() => expect(called("capture_overlay_context")).toBe(true));
    // Give the context's render a turn before checking.
    await act(async () => undefined);
    expect(screen.queryByTestId("capture-instant-hint")).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Capture" })).toBeNull();
  });
});

// The area already drawn is AREA (100,100 400x300). As in macOS's ⌘⇧5: a
// press outside it starts a new one, inside moves it, on a handle resizes it.
describe("drawing over an area that is already there", () => {
  const at = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0 });
  const handedOver = () =>
    tauri.core.invoke.mock.calls.filter(([c]) => c === "capture_set_pending").map(([, args]) => args);
  const drag = (el: HTMLElement, from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(el, at(...from));
    fireEvent.pointerMove(el, at(...to));
    fireEvent.pointerUp(el, at(...to));
  };
  const surface = async () => {
    const { container } = setup();
    await screen.findByRole("toolbar", { name: "Capture" });
    expect(screen.getByText("400 × 300")).toBeInTheDocument();
    return container.firstElementChild as HTMLElement;
  };

  it("replaces the area with a new one dragged outside it", async () => {
    const el = await surface();
    drag(el, [600, 500], [800, 700]);
    expect(handedOver()).toEqual([
      { selection: { target: "area", displayId: 1, rect: { x: 600, y: 500, width: 200, height: 200 } } },
    ]);
    expect(screen.getByText("200 × 200")).toBeInTheDocument();
    expect(screen.queryByText("400 × 300")).toBeNull();
  });

  it("shows only the new area while it is being dragged", async () => {
    const el = await surface();
    fireEvent.pointerDown(el, at(600, 500));
    fireEvent.pointerMove(el, at(700, 560));
    expect(screen.getByText("100 × 60")).toBeInTheDocument();
    expect(screen.queryByText("400 × 300")).toBeNull();
  });

  it("moves the area when the drag starts inside it", async () => {
    const el = await surface();
    drag(el, [300, 250], [350, 280]);
    expect(handedOver()).toEqual([
      { selection: { target: "area", displayId: 1, rect: { x: 150, y: 130, width: 400, height: 300 } } },
    ]);
    expect(screen.getByText("400 × 300")).toBeInTheDocument();
  });

  it("resizes the area when the drag starts on a handle", async () => {
    const el = await surface();
    // The bottom-right handle, pressed a few points off its centre.
    drag(el, [503, 404], [600, 450]);
    expect(handedOver()).toEqual([
      { selection: { target: "area", displayId: 1, rect: { x: 100, y: 100, width: 500, height: 350 } } },
    ]);
    expect(screen.getByText("500 × 350")).toBeInTheDocument();
  });

  // A click is a drag too short to be an area, and that already keeps what
  // was drawn: a stray click must not throw away a carefully framed area.
  it("keeps the area on a click outside it, with no zero-size frame", async () => {
    const el = await surface();
    fireEvent.pointerDown(el, at(800, 700));
    fireEvent.pointerUp(el, at(800, 700));
    expect(handedOver()).toEqual([]);
    expect(screen.getByText("400 × 300")).toBeInTheDocument();
    expect(screen.queryByText("0 × 0")).toBeNull();
  });
});
