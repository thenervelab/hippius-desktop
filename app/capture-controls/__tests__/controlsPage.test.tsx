import { beforeEach, describe, expect, it, vi } from "vitest";
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
