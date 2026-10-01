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

describe("the pill offers no microphone mute", () => {
  // The recording helper has no command to mute mid-recording.
  it("shows the microphone as a status, not a button", async () => {
    setup({ phase: "recording", elapsedSecs: 3, microphone: true, seq: 1 });
    await screen.findByRole("button", { name: "Stop recording" });
    expect(screen.getByRole("img", { name: "Recording the microphone" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mute/i })).toBeNull();
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
