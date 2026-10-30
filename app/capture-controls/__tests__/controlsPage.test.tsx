import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { CapturePhaseEvent } from "@/app/lib/tauri/capture";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

import CaptureControlsPage from "../page";
import { discardNeedsConfirm } from "../discard";

const recording = (elapsedSecs: number, seq = 1): CapturePhaseEvent => ({ phase: "recording", elapsedSecs, microphone: false, seq });
const NO_CAMERA = {
  shape: null,
  hidden: false,
  deviceId: null,
  deviceName: null,
  size: "small",
  recording: true,
  cameraFilmed: true,
  recorderOwnsCamera: false,
  switchFromPill: false,
  resizeFromPill: false,
};
const called = (cmd: string) => tauri.core.invoke.mock.calls.some(([c]) => c === cmd);

function setup(phase: CapturePhaseEvent) {
  tauri.onInvoke("capture_state", () => phase);
  tauri.onInvoke("capture_camera_context", () => NO_CAMERA);
  tauri.onInvoke("capture_cancel", () => null);
  tauri.onInvoke("capture_stop", () => null);
  tauri.onInvoke("capture_restart", () => null);
  return render(<CaptureControlsPage />);
}

beforeEach(() => tauri.reset());

describe("discarding a recording", () => {
  it("asks first from five seconds on", () => {
    expect(discardNeedsConfirm(4)).toBe(false);
    expect(discardNeedsConfirm(5)).toBe(true);
  });

  it("throws a false start away at once", async () => {
    setup(recording(2));
    fireEvent.click(await screen.findByRole("button", { name: "Discard recording" }));
    await waitFor(() => expect(called("capture_cancel")).toBe(true));
  });

  it("asks before throwing a longer recording away, and Keep recording keeps it", async () => {
    setup(recording(90));
    fireEvent.click(await screen.findByRole("button", { name: "Discard recording" }));
    const dialog = screen.getByRole("alertdialog", { name: "Discard this recording?" });
    expect(dialog).toHaveTextContent("Nothing will be saved.");
    expect(screen.getByRole("button", { name: "Keep recording" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep recording" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(called("capture_cancel")).toBe(false);
  });

  it("discards on Discard", async () => {
    setup(recording(90));
    fireEvent.click(await screen.findByRole("button", { name: "Discard recording" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(called("capture_cancel")).toBe(true));
  });

  it("takes Escape at the question as Keep recording", async () => {
    setup(recording(90));
    fireEvent.click(await screen.findByRole("button", { name: "Discard recording" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(called("capture_cancel")).toBe(false);
  });

  // The pill turns key when clicked, so a stray Escape meant for another app
  // landed here and threw the recording away.
  it("does nothing on Escape, in any phase", async () => {
    setup(recording(90));
    await screen.findByRole("button", { name: "Pause recording" });
    fireEvent.keyDown(window, { key: "Escape" });
    await act(() => tauri.emitEvent("capture_state_changed", { phase: "capturing", kind: "recording", seq: 2 }));
    expect(screen.getByText("Starting recording…")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(called("capture_cancel")).toBe(false);
  });
});

describe("the pill", () => {
  // `-webkit-app-region` is Electron's; Tauri moves a window from this attribute.
  it("is draggable by its body", async () => {
    const { container } = setup(recording(3));
    await screen.findByRole("button", { name: "Stop recording" });
    expect(container.querySelector("[data-tauri-drag-region]")).toBeInTheDocument();
  });

  it("does not let a late first read put an older phase back", async () => {
    let answer: (p: CapturePhaseEvent) => void = () => undefined;
    tauri.onInvoke("capture_state", () => new Promise<CapturePhaseEvent>((r) => (answer = r)));
    tauri.onInvoke("capture_camera_context", () => NO_CAMERA);
    render(<CaptureControlsPage />);
    await act(() => tauri.emitEvent("capture_state_changed", { phase: "finalizing", seq: 5 }));
    await act(async () => answer(recording(10, 4)));
    expect(screen.getByText("Saving recording…")).toBeInTheDocument();
  });

  // Rust numbers every phase; an event older than what the pill shows is dropped.
  it("ignores a phase event older than the one it shows", async () => {
    setup(recording(10, 7));
    await screen.findByRole("button", { name: "Stop recording" });
    await act(() => tauri.emitEvent("capture_state_changed", { phase: "finalizing", seq: 6 }));
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeInTheDocument();
    await act(() => tauri.emitEvent("capture_state_changed", { phase: "finalizing", seq: 8 }));
    expect(screen.getByText("Saving recording…")).toBeInTheDocument();
  });
});

describe("restarting a recording", () => {
  it("starts again at once after a false start", async () => {
    setup(recording(3));
    fireEvent.click(await screen.findByRole("button", { name: "Restart recording" }));
    await waitFor(() => expect(called("capture_restart")).toBe(true));
    expect(called("capture_cancel")).toBe(false);
  });

  // Restart throws the take away, so past a few seconds it asks as Discard does.
  it("asks first from five seconds on, and Keep recording keeps it", async () => {
    setup(recording(5));
    const restart = await screen.findByRole("button", { name: "Restart recording" });
    fireEvent.click(restart);
    const dialog = screen.getByRole("alertdialog", { name: "Restart this recording?" });
    expect(dialog).toHaveTextContent("What you recorded is thrown away.");
    expect(screen.getByRole("button", { name: "Keep recording" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep recording" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Restart recording" })).toHaveFocus();
    expect(called("capture_restart")).toBe(false);
  });

  it("restarts on Restart, and never discards", async () => {
    setup(recording(40));
    fireEvent.click(await screen.findByRole("button", { name: "Restart recording" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(called("capture_restart")).toBe(true));
    expect(called("capture_cancel")).toBe(false);
  });

  it("takes Escape at the question as Keep recording", async () => {
    setup(recording(40));
    fireEvent.click(await screen.findByRole("button", { name: "Restart recording" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(called("capture_restart")).toBe(false);
  });
});

describe("the microphone mid-recording", () => {
  const MIC = { recorded: true, muted: false, deviceId: null, canMute: true, canSwitch: true };
  const MICS = [
    { id: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", isDefault: true },
    { id: "usb-1", name: "Yeti Stereo Microphone", isDefault: false },
  ];
  const withMic = (elapsedSecs = 3): CapturePhaseEvent => ({ phase: "recording", elapsedSecs, microphone: true, seq: 1 });
  const argsOf = (cmd: string) => tauri.core.invoke.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);

  beforeEach(() => {
    tauri.onInvoke("capture_controls_menu", () => ({ above: true }));
    tauri.onInvoke("capture_microphones", () => MICS);
  });

  it("mutes and unmutes from the pill, in Rust's state", async () => {
    tauri.onInvoke("capture_microphone_state", () => MIC);
    tauri.onInvoke("capture_microphone_mute", (a) => ({ ...MIC, muted: (a as { muted: boolean }).muted }));
    setup(withMic());
    const mute = await screen.findByRole("button", { name: "Mute microphone" });
    expect(mute).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(mute);
    const unmute = await screen.findByRole("button", { name: "Unmute microphone" });
    expect(unmute).toHaveAttribute("aria-pressed", "true");
    expect(argsOf("capture_microphone_mute")).toEqual([{ muted: true }]);
    fireEvent.click(unmute);
    expect(await screen.findByRole("button", { name: "Mute microphone" })).toBeInTheDocument();
    expect(argsOf("capture_microphone_mute")).toEqual([{ muted: true }, { muted: false }]);
  });

  // Windows and Linux recorders have no mute yet: Rust says so, and the
  // microphone stays a status, never a button that does nothing.
  it("shows the microphone as a status where Rust offers no mute", async () => {
    tauri.onInvoke("capture_microphone_state", () => ({ ...MIC, canMute: false, canSwitch: false }));
    setup(withMic());
    await screen.findByRole("button", { name: "Stop recording" });
    expect(screen.getByRole("img", { name: "Recording the microphone" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mute/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose a microphone" })).toBeNull();
  });

  it("says when muting fails, and Try again mutes", async () => {
    tauri.onInvoke("capture_microphone_state", () => MIC);
    tauri.onInvoke("capture_microphone_mute", () => {
      throw new Error("the recorder did not answer");
    });
    setup(withMic());
    fireEvent.click(await screen.findByRole("button", { name: "Mute microphone" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't mute the microphone. It's still recording sound.");
    tauri.onInvoke("capture_microphone_mute", (a) => ({ ...MIC, muted: (a as { muted: boolean }).muted }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Unmute microphone" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("follows Rust's state when it arrives as an event", async () => {
    tauri.onInvoke("capture_microphone_state", () => MIC);
    setup(withMic());
    await screen.findByRole("button", { name: "Mute microphone" });
    await act(() => tauri.emitEvent("capture_microphone_state", { ...MIC, muted: true }));
    expect(screen.getByRole("button", { name: "Unmute microphone" })).toBeInTheDocument();
  });

  it("switches to another microphone from its menu, then closes it", async () => {
    tauri.onInvoke("capture_microphone_state", () => MIC);
    tauri.onInvoke("capture_microphone_switch", (a) => ({ ...MIC, deviceId: (a as { device: string }).device }));
    setup(withMic());
    const trigger = await screen.findByRole("button", { name: "Choose a microphone" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Choose a microphone" });
    const yeti = await screen.findByRole("menuitemradio", { name: /Yeti Stereo Microphone/ });
    // The default is the one recorded now.
    expect(screen.getByRole("menuitemradio", { name: /MacBook Pro Microphone/ })).toHaveAttribute("aria-checked", "true");
    expect(argsOf("capture_controls_menu")).toEqual([{ open: true }]);
    fireEvent.click(yeti);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(menu).not.toBeInTheDocument();
    expect(argsOf("capture_microphone_switch")).toEqual([{ device: "usb-1" }]);
    expect(argsOf("capture_controls_menu")).toEqual([{ open: true }, { open: false }]);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps the menu open with Rust's line when a microphone is refused", async () => {
    const line = "That microphone is not connected.";
    tauri.onInvoke("capture_microphone_state", () => MIC);
    tauri.onInvoke("capture_microphone_switch", () => {
      throw { kind: "Other", message: line };
    });
    setup(withMic());
    fireEvent.click(await screen.findByRole("button", { name: "Choose a microphone" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Yeti Stereo Microphone/ }));
    expect(await screen.findByText(line)).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Choose a microphone" })).toBeInTheDocument();
  });

  it("closes the menu on Escape and gives focus back to its button", async () => {
    tauri.onInvoke("capture_microphone_state", () => MIC);
    setup(withMic());
    const trigger = await screen.findByRole("button", { name: "Choose a microphone" });
    fireEvent.click(trigger);
    const first = await screen.findByRole("menuitemradio", { name: /MacBook Pro Microphone/ });
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: /Yeti Stereo Microphone/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger).toHaveFocus();
    // Escape on the pill never throws the recording away.
    expect(called("capture_cancel")).toBe(false);
  });

  it("opens the menu below the pill when Rust grew the window downward", async () => {
    tauri.onInvoke("capture_controls_menu", () => ({ above: false }));
    tauri.onInvoke("capture_microphone_state", () => MIC);
    setup(withMic());
    fireEvent.click(await screen.findByRole("button", { name: "Choose a microphone" }));
    const menu = await screen.findByRole("menu", { name: "Choose a microphone" });
    const pill = screen.getByRole("group", { name: "Recording controls" });
    expect(pill.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the camera mid-recording", () => {
  const CAMERAS = [
    { id: "1F06", name: "FaceTime HD Camera", isDefault: true },
    { id: "9160", name: "Ahmad's iPhone Camera", isDefault: false },
  ];
  const BUBBLE = { ...NO_CAMERA, shape: "bubble", switchFromPill: true, resizeFromPill: true };
  const argsOf = (cmd: string) => tauri.core.invoke.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);

  function withCamera(camera: object) {
    tauri.onInvoke("capture_controls_menu", () => ({ above: true }));
    tauri.onInvoke("capture_cameras", () => CAMERAS);
    tauri.onInvoke("capture_camera_set_size", (a) => (a as { size: string }).size);
    tauri.onInvoke("capture_camera_switch", () => null);
    tauri.onInvoke("capture_state", () => recording(4));
    tauri.onInvoke("capture_camera_context", () => camera);
    return render(<CaptureControlsPage />);
  }

  it("changes the bubble's size from the pill", async () => {
    withCamera(BUBBLE);
    fireEvent.click(await screen.findByRole("button", { name: "Camera options" }));
    await screen.findByRole("menu", { name: "Camera options" });
    expect(screen.getByRole("menuitemradio", { name: "Small" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Full size" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(argsOf("capture_camera_set_size")).toEqual([{ size: "full" }]);
  });

  it("switches the camera from the pill", async () => {
    withCamera({ ...BUBBLE, deviceId: "1F06", deviceName: "FaceTime HD Camera" });
    fireEvent.click(await screen.findByRole("button", { name: "Camera options" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /iPhone Camera/ }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(argsOf("capture_camera_switch")).toEqual([{ device: "9160" }]);
  });

  // The stage is the recording: it can switch camera but has no size to change.
  it("offers the stage a camera menu without sizes", async () => {
    withCamera({ ...NO_CAMERA, shape: "stage", size: "full", switchFromPill: true, resizeFromPill: false });
    fireEvent.click(await screen.findByRole("button", { name: "Camera options" }));
    await screen.findByRole("menuitemradio", { name: /FaceTime HD Camera/ });
    expect(screen.queryByRole("menuitemradio", { name: "Small" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide camera" })).toBeNull();
  });

  // The pill first hears the camera at Record, before the recording runs,
  // when Rust offers no camera menu; Rust sends it again once recording.
  it("offers the camera menu once Rust says the recording runs", async () => {
    withCamera({ ...BUBBLE, switchFromPill: false, resizeFromPill: false });
    await screen.findByRole("button", { name: "Hide camera" });
    expect(screen.queryByRole("button", { name: "Camera options" })).toBeNull();
    await act(() => tauri.emitEvent("capture_camera_state", BUBBLE));
    fireEvent.click(await screen.findByRole("button", { name: "Camera options" }));
    expect(await screen.findByRole("menuitemradio", { name: "Large" })).toBeInTheDocument();
    expect(await screen.findByRole("menuitemradio", { name: /iPhone Camera/ })).toBeInTheDocument();
  });

  it("offers no camera menu where Rust offers none", async () => {
    withCamera({ ...BUBBLE, switchFromPill: false, resizeFromPill: false });
    await screen.findByRole("button", { name: "Hide camera" });
    expect(screen.queryByRole("button", { name: "Camera options" })).toBeNull();
  });

  // The grown window must not stay over the app the user turned to.
  it("closes an open menu when the pill loses focus", async () => {
    withCamera(BUBBLE);
    fireEvent.click(await screen.findByRole("button", { name: "Camera options" }));
    await screen.findByRole("menu");
    // The blur listener is added by an effect after the menu renders; on a
    // slow runner it may not have run yet when findByRole returns.
    await act(async () => {});
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(argsOf("capture_controls_menu")).toEqual([{ open: true }, { open: false }]));
  });

  it("closes an open menu when the recording ends", async () => {
    withCamera(BUBBLE);
    fireEvent.click(await screen.findByRole("button", { name: "Camera options" }));
    await screen.findByRole("menu");
    await act(() => tauri.emitEvent("capture_state_changed", { phase: "finalizing", seq: 9 }));
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(argsOf("capture_controls_menu")).toEqual([{ open: true }, { open: false }]));
  });
});

// The bar must not move while a menu opens or closes ("the bar jumps up").
describe("the pill stays put while a menu opens and closes", () => {
  const MIC = { recorded: true, muted: false, deviceId: null, canMute: true, canSwitch: true };
  const MICS = [{ id: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", isDefault: true }];
  const withMic: CapturePhaseEvent = { phase: "recording", elapsedSecs: 3, microphone: true, seq: 1 };
  const anchor = () => document.querySelector("[data-anchor]")?.getAttribute("data-anchor");
  const order = () =>
    tauri.core.invoke.mock.calls
      .map(([c, a]) => (c === "capture_controls_menu" ? `menu:${(a as { open: boolean }).open}` : c))
      .filter((c) => c === "capture_controls_menu_side" || c.startsWith("menu:"));

  beforeEach(() => {
    tauri.onInvoke("capture_microphone_state", () => MIC);
    tauri.onInvoke("capture_microphones", () => MICS);
  });

  // Where the page grows with its window (Windows), the pill was drawn at
  // the top of a window that had just grown upward, a menu's height above
  // where it was, until the menu arrived. It is anchored to the bottom
  // first, and only then is the room asked for.
  it("anchors the pill to the edge that stays put before the window grows", async () => {
    let anchoredWhenGrown: string | null | undefined = null;
    tauri.onInvoke("capture_controls_menu_side", () => ({ above: true }));
    tauri.onInvoke("capture_controls_menu", (a) => {
      if ((a as { open: boolean }).open) anchoredWhenGrown = anchor();
      return { above: true };
    });
    setup(withMic);
    const trigger = await screen.findByRole("button", { name: "Choose a microphone" });
    expect(anchor()).toBe("middle");
    fireEvent.click(trigger);
    await screen.findByRole("menu", { name: "Choose a microphone" });
    expect(anchoredWhenGrown).toBe("bottom");
    expect(order()).toEqual(["capture_controls_menu_side", "menu:true"]);
    const slots = Array.from(document.querySelectorAll("[data-menu-slot]"));
    expect(slots.map((el) => el.getAttribute("data-menu-slot"))).toEqual(["above", "below"]);
    expect(slots[0]).toContainElement(screen.getByRole("menu"));
    expect(slots[1]).toHaveClass("hidden");
  });

  it("keeps the pill on that edge until the window has shrunk back", async () => {
    let shrunk: () => void = () => undefined;
    tauri.onInvoke("capture_controls_menu_side", () => ({ above: true }));
    tauri.onInvoke("capture_controls_menu", (a) =>
      (a as { open: boolean }).open ? { above: true } : new Promise((r) => (shrunk = () => r({ above: true }))),
    );
    setup(withMic);
    fireEvent.click(await screen.findByRole("button", { name: "Choose a microphone" }));
    fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(anchor()).toBe("bottom");
    await act(async () => shrunk());
    expect(anchor()).toBe("middle");
  });

  it("anchors to the top when the menu opens below, near the top of the screen", async () => {
    let anchoredWhenGrown: string | null | undefined = null;
    tauri.onInvoke("capture_controls_menu_side", () => ({ above: false }));
    tauri.onInvoke("capture_controls_menu", (a) => {
      if ((a as { open: boolean }).open) anchoredWhenGrown = anchor();
      return { above: false };
    });
    setup(withMic);
    fireEvent.click(await screen.findByRole("button", { name: "Choose a microphone" }));
    await screen.findByRole("menu");
    expect(anchoredWhenGrown).toBe("top");
  });

  // macOS: the page is laid out once with the room on both sides and never
  // resized, so nothing in it moves; the window only shows more of it.
  it("keeps fixed room above and below the pill where Rust lays the page out once", async () => {
    tauri.onInvoke("capture_controls_context", () => ({ compact: false, filmedNote: null, menuRoom: 300 }));
    tauri.onInvoke("capture_controls_menu", () => ({ above: true }));
    setup(withMic);
    await screen.findByRole("button", { name: "Choose a microphone" });
    await waitFor(() => expect(document.querySelector<HTMLElement>("[data-menu-slot=above]")?.style.height).toBe("300px"));
    const below = document.querySelector<HTMLElement>("[data-menu-slot=below]");
    expect(below?.style.height).toBe("300px");
    expect(below).not.toHaveClass("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Choose a microphone" }));
    const menu = await screen.findByRole("menu");
    expect(document.querySelector("[data-menu-slot=above]")).toContainElement(menu);
    // Nothing to anchor: the side is not asked for first.
    expect(order()).toEqual(["menu:true"]);
    expect(anchor()).toBe("middle");
  });
});

describe("a sound source lost mid-recording", () => {
  const MIC_LOST = "The microphone was disconnected. The recording goes on without it.";

  // Rust sends the line (`recording::device_lost_message`); the pill never words it.
  it("swaps the microphone for Rust's line and announces it", async () => {
    setup({ phase: "recording", elapsedSecs: 3, microphone: true, seq: 1 });
    await screen.findByRole("button", { name: "Stop recording" });
    await act(() => tauri.emitEvent("capture_device_lost", { device: "microphone", message: MIC_LOST }));
    expect(screen.getByRole("img", { name: MIC_LOST })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Recording the microphone" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(MIC_LOST);
    // The recording goes on: Stop is still there.
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeInTheDocument();
  });

  it("names lost system audio too", async () => {
    const line = "System audio stopped. The recording goes on without it.";
    setup(recording(3));
    await screen.findByRole("button", { name: "Stop recording" });
    await act(() => tauri.emitEvent("capture_device_lost", { device: "systemAudio", message: line }));
    expect(screen.getByRole("img", { name: line })).toBeInTheDocument();
  });

  it("forgets the line once the recording is over", async () => {
    setup({ phase: "recording", elapsedSecs: 3, microphone: true, seq: 1 });
    await screen.findByRole("button", { name: "Stop recording" });
    await act(() => tauri.emitEvent("capture_device_lost", { device: "microphone", message: MIC_LOST }));
    await act(() => tauri.emitEvent("capture_state_changed", { phase: "idle", seq: 2 }));
    await act(() => tauri.emitEvent("capture_state_changed", { phase: "recording", elapsedSecs: 0, microphone: true, seq: 3 }));
    expect(screen.getByRole("img", { name: "Recording the microphone" })).toBeInTheDocument();
  });
});

describe("the countdown after the desktop's dialog (Wayland)", () => {
  const starting: CapturePhaseEvent = { phase: "capturing", kind: "recording", seq: 1 };

  it("counts in the pill, then the recording's controls take over", async () => {
    setup(starting);
    expect(await screen.findByText("Starting recording…")).toBeInTheDocument();
    await act(() => tauri.emitEvent("capture_pill_countdown", 3));
    expect(screen.getByRole("timer")).toHaveTextContent("Recording in 3");
    await act(() => tauri.emitEvent("capture_pill_countdown", 2));
    expect(screen.getByRole("timer")).toHaveTextContent("Recording in 2");
    await act(() => tauri.emitEvent("capture_pill_countdown", null));
    expect(screen.getByText("Starting recording…")).toBeInTheDocument();
    await act(() => tauri.emitEvent("capture_state_changed", recording(0, 2)));
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeInTheDocument();
  });

  it("starts at once on Start now, and Cancel throws it away", async () => {
    tauri.onInvoke("capture_skip_countdown", () => null);
    setup(starting);
    await screen.findByText("Starting recording…");
    await act(() => tauri.emitEvent("capture_pill_countdown", 5));
    fireEvent.click(screen.getByRole("button", { name: "Start now" }));
    await waitFor(() => expect(called("capture_skip_countdown")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
    await waitFor(() => expect(called("capture_cancel")).toBe(true));
  });
});

describe("where the pill is filmed (Linux)", () => {
  const NOTE = "These controls show in screen recordings. They stay small; point at them to use them.";

  it("stays a dot and the time until pointed at, then shows every control", async () => {
    tauri.onInvoke("capture_controls_context", () => ({ compact: true, filmedNote: null }));
    setup(recording(12));
    const group = await screen.findByRole("group", { name: "Recording controls" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop recording" })).toBeNull());
    expect(screen.getByRole("timer")).toHaveTextContent("00:12");
    fireEvent.pointerEnter(group);
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeInTheDocument();
  });

  it("opens from the keyboard too", async () => {
    tauri.onInvoke("capture_controls_context", () => ({ compact: true, filmedNote: null }));
    setup(recording(12));
    const group = await screen.findByRole("group", { name: "Recording controls" });
    await waitFor(() => expect(group).toHaveAttribute("tabindex", "0"));
    fireEvent.focus(group);
    expect(screen.getByRole("button", { name: "Pause recording" })).toBeInTheDocument();
  });

  it("says once that it is filmed, until Got it", async () => {
    tauri.onInvoke("capture_controls_context", () => ({ compact: true, filmedNote: NOTE }));
    setup(recording(1));
    expect(await screen.findByRole("status")).toHaveTextContent(NOTE);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.getByRole("group", { name: "Recording controls" })).toBeInTheDocument();
  });

  it("keeps every control where it is not filmed (macOS, Windows)", async () => {
    tauri.onInvoke("capture_controls_context", () => ({ compact: false, filmedNote: null }));
    setup(recording(12));
    expect(await screen.findByRole("button", { name: "Stop recording" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Recording controls" })).not.toHaveAttribute("tabindex");
  });
});

describe("a Free plan recording near its limit", () => {
  it("shows the time recorded until Rust sends the time left", async () => {
    setup(recording(200));
    expect(await screen.findByRole("timer")).toHaveTextContent("03:20");
    expect(screen.getByRole("timer")).not.toHaveTextContent("left");
  });

  // Rust decides when (the last minute) and how much; the pill only draws it.
  it("shows the time left in its last minute, paused or not", async () => {
    setup({ phase: "recording", elapsedSecs: 241, microphone: false, remainingSecs: 59, seq: 1 });
    const timer = await screen.findByRole("timer");
    expect(timer).toHaveTextContent("00:59left");
    expect(timer).toHaveAccessibleName("Recording time 04:01, 00:59 left");
    await act(() =>
      tauri.emitEvent("capture_state_changed", { phase: "paused", elapsedSecs: 250, microphone: false, remainingSecs: 50, seq: 2 }),
    );
    expect(screen.getByRole("timer")).toHaveAccessibleName("Recording time 04:10, 00:50 left, paused");
  });

  it("shows the time left on the small pill where it is filmed (Linux)", async () => {
    tauri.onInvoke("capture_controls_context", () => ({ compact: true, filmedNote: null }));
    setup({ phase: "recording", elapsedSecs: 290, microphone: false, remainingSecs: 10, seq: 1 });
    await screen.findByRole("group", { name: "Recording controls" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop recording" })).toBeNull());
    expect(screen.getByRole("timer")).toHaveTextContent("00:10left");
  });
});

// The pill is never the key window, so on macOS its webview gets no hover and
// a native `title` never shows. Rust says where the pointer is on the pill's
// row; the page finds the button there (the hit test, which jsdom lacks, is
// stood in for) and asks Rust to show its tooltip over the pill.
describe("the pill's tooltips", () => {
  const MIC = { recorded: true, muted: false, deviceId: null, canMute: true, canSwitch: true };
  const withMic = (elapsedSecs = 3, seq = 1): CapturePhaseEvent => ({ phase: "recording", elapsedSecs, microphone: true, seq });
  const tips = () => tauri.core.invoke.mock.calls.filter(([c]) => c === "capture_pill_tip").map(([, a]) => (a as { tip: unknown }).tip);
  const lastTip = () => tips().at(-1) as { label: string; detail?: string; anchor: object; fromPointer: boolean } | null | undefined;
  let under: Element | null = null;
  const hits: [number, number][] = [];

  beforeEach(() => {
    under = null;
    hits.length = 0;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (x: number, y: number) => {
        hits.push([x, y]);
        return under;
      },
    });
    tauri.onInvoke("capture_pill_tip", () => null);
    tauri.onInvoke("capture_microphone_state", () => MIC);
    tauri.onInvoke("capture_controls_context", () => ({
      compact: false,
      filmedNote: null,
      menuRoom: 0,
      tips: true,
      stopShortcut: "CommandOrControl+Alt+Shift+2",
    }));
  });
  afterEach(() => {
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  /** Rust: the pointer is on `el` (a point on the pill's row), or off the pill. */
  const point = async (el: Element | null, at = { x: 300, y: 30 }) => {
    under = el;
    await act(() => tauri.emitEvent("capture_pill_pointer", el ? at : null));
  };

  it("names the button under Rust's pointer, with the key that does it, and never carries a native title", async () => {
    setup(withMic());
    const stop = await screen.findByRole("button", { name: "Stop recording" });
    await waitFor(() => expect(called("capture_controls_context")).toBe(true));
    // An icon inside the button is what the hit test finds.
    await point(stop.querySelector("svg"));
    await waitFor(() => expect(lastTip()).toMatchObject({ label: "Stop recording", fromPointer: true }));
    // Rust's point is on the pill's row; the hit test is in page pixels from
    // the row's corner (0, 0 in jsdom).
    expect(hits.at(-1)).toEqual([300, 30]);
    // Not a Mac in jsdom: the keys as Windows and Linux write them.
    expect(lastTip()?.detail).toBe("Press Ctrl+Alt+Shift+2");
    expect(lastTip()?.anchor).toEqual({ left: 0, top: 0, width: 0, height: 0 });
    // Lit as `:hover` would, which never happens in a window that is not key.
    expect(stop).toHaveAttribute("data-hover", "true");
    expect(document.querySelector("[title]")).toBeNull();
    expect(document.querySelector("title")).toBeNull();
  });

  it("names every control on the pill", async () => {
    setup(withMic());
    await screen.findByRole("button", { name: "Mute microphone" });
    await waitFor(() => expect(called("capture_controls_context")).toBe(true));
    for (const name of ["Mute microphone", "Choose a microphone", "Pause recording", "Restart recording", "Stop recording", "Discard recording"]) {
      await point(screen.getByRole("button", { name }));
      await waitFor(() => expect(lastTip()?.label).toBe(name));
    }
  });

  it("takes the tooltip away when the pointer leaves the button or the pill", async () => {
    setup(withMic());
    const pause = await screen.findByRole("button", { name: "Pause recording" });
    await waitFor(() => expect(called("capture_controls_context")).toBe(true));
    await point(pause);
    await waitFor(() => expect(lastTip()?.label).toBe("Pause recording"));
    // On the pill's glass between buttons: no button, no tooltip.
    await point(screen.getByRole("timer"));
    await waitFor(() => expect(lastTip()).toBeNull());
    expect(pause).not.toHaveAttribute("data-hover");
    await point(pause);
    await waitFor(() => expect(lastTip()?.label).toBe("Pause recording"));
    await point(null);
    await waitFor(() => expect(lastTip()).toBeNull());
  });

  // Pause becomes Resume under a pointer that did not move.
  it("follows the button's words as they change under the pointer", async () => {
    setup(withMic());
    const pause = await screen.findByRole("button", { name: "Pause recording" });
    await waitFor(() => expect(called("capture_controls_context")).toBe(true));
    await point(pause);
    await waitFor(() => expect(lastTip()?.label).toBe("Pause recording"));
    under = null;
    await act(() => tauri.emitEvent("capture_state_changed", { phase: "paused", elapsedSecs: 3, microphone: true, seq: 2 }));
    under = screen.getByRole("button", { name: "Resume recording" });
    await point(under);
    await waitFor(() => expect(lastTip()?.label).toBe("Resume recording"));
  });

  it("asks Rust only when something changed", async () => {
    setup(withMic());
    const stop = await screen.findByRole("button", { name: "Stop recording" });
    await waitFor(() => expect(called("capture_controls_context")).toBe(true));
    await point(stop, { x: 300, y: 30 });
    await waitFor(() => expect(lastTip()?.label).toBe("Stop recording"));
    const sent = tips().length;
    // The pointer moves on the same button.
    await point(stop, { x: 302, y: 31 });
    await point(stop, { x: 304, y: 29 });
    expect(tips().length).toBe(sent);
  });

  it("names a button that has keyboard focus, from the keyboard only", async () => {
    setup(withMic());
    const restart = await screen.findByRole("button", { name: "Restart recording" });
    await waitFor(() => expect(called("capture_controls_context")).toBe(true));
    act(() => restart.focus());
    await waitFor(() => expect(lastTip()).toMatchObject({ label: "Restart recording", fromPointer: false }));
    act(() => restart.blur());
    await waitFor(() => expect(lastTip()).toBeNull());
  });

  // Linux films the pill, so a tooltip would be in the video: Rust offers none.
  it("asks for no tooltip where Rust says the pill has none", async () => {
    tauri.onInvoke("capture_controls_context", () => ({ compact: false, filmedNote: null, menuRoom: 0, tips: false }));
    setup(withMic());
    const stop = await screen.findByRole("button", { name: "Stop recording" });
    await waitFor(() => expect(called("capture_controls_context")).toBe(true));
    await point(stop);
    act(() => stop.focus());
    await act(async () => undefined);
    expect(tips().filter((t) => t !== null)).toEqual([]);
    expect(document.querySelector("[title]")).toBeNull();
  });
});

describe("pausing and resuming", () => {
  it("says when Pause fails, keeps recording, and OK brings the pill back", async () => {
    tauri.onInvoke("capture_pause", () => {
      throw new Error("the recorder did not answer");
    });
    setup(recording(30));
    fireEvent.click(await screen.findByRole("button", { name: "Pause recording" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't pause the recording. It's still recording.");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(await screen.findByRole("button", { name: "Pause recording" })).toBeInTheDocument();
  });

  it("says when Resume fails, and Try again resumes", async () => {
    tauri.onInvoke("capture_resume", () => {
      throw new Error("the recorder did not answer");
    });
    setup({ phase: "paused", elapsedSecs: 30, microphone: false, seq: 1 } as CapturePhaseEvent);
    fireEvent.click(await screen.findByRole("button", { name: "Resume recording" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't resume the recording. It's still paused.");
    tauri.onInvoke("capture_resume", () => null);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(tauri.core.invoke.mock.calls.filter(([c]) => c === "capture_resume")).toHaveLength(2);
  });
});
