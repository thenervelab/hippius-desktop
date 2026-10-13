import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { CaptureCameraState, CapturePhaseEvent } from "@/app/lib/tauri/capture";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

import CaptureBubbleControlsPage from "../page";

const recording = (seq = 1): CapturePhaseEvent => ({ phase: "recording", elapsedSecs: 4, microphone: true, seq });
const paused = (seq = 1): CapturePhaseEvent => ({ phase: "paused", elapsedSecs: 4, microphone: true, seq });
const BUBBLE: CaptureCameraState = {
  shape: "bubble",
  hidden: false,
  deviceId: null,
  deviceName: null,
  size: "small",
  recording: true,
  cameraFilmed: true,
  recorderOwnsCamera: false,
  switchFromPill: true,
  resizeFromPill: true,
};
const argsOf = (cmd: string) => tauri.core.invoke.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);
const called = (cmd: string) => argsOf(cmd).length > 0;

function setup(phase: CapturePhaseEvent, camera: CaptureCameraState = BUBBLE) {
  tauri.onInvoke("capture_state", () => phase);
  tauri.onInvoke("capture_camera_context", () => camera);
  tauri.onInvoke("capture_pause", () => null);
  tauri.onInvoke("capture_resume", () => null);
  tauri.onInvoke("capture_camera_set_size", (a) => (a as { size: string }).size);
  return render(<CaptureBubbleControlsPage />);
}

beforeEach(() => tauri.reset());

describe("the camera bubble's controls", () => {
  it("offers the bubble's sizes and pause, each a named button in one toolbar", async () => {
    setup(recording());
    const toolbar = await screen.findByRole("toolbar", { name: "Camera and recording" });
    const names = Array.from(toolbar.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Small camera", "Large camera", "Full size camera", "Pause recording"]);
    expect(screen.getByRole("button", { name: "Small camera" })).toHaveAttribute("aria-pressed", "true");
  });

  // Same command as the pill's camera menu, so the bar, the bubble and the
  // saved video agree.
  it("changes the size through the command the pill uses", async () => {
    setup(recording());
    fireEvent.click(await screen.findByRole("button", { name: "Large camera" }));
    await waitFor(() => expect(argsOf("capture_camera_set_size")).toEqual([{ size: "large" }]));
  });

  it("leaves full size back to the round size from before", async () => {
    setup(recording(), { ...BUBBLE, size: "large" });
    await screen.findByRole("button", { name: "Large camera" });
    await act(() => tauri.emitEvent("capture_camera_state", { ...BUBBLE, size: "full" }));
    fireEvent.click(screen.getByRole("button", { name: "Exit full size" }));
    await waitFor(() => expect(argsOf("capture_camera_set_size")).toEqual([{ size: "large" }]));
  });

  it("pauses and resumes through the pill's commands, showing Rust's phase", async () => {
    setup(recording());
    fireEvent.click(await screen.findByRole("button", { name: "Pause recording" }));
    await waitFor(() => expect(called("capture_pause")).toBe(true));
    // The button follows the phase Rust sends, not its own click.
    expect(screen.getByRole("button", { name: "Pause recording" })).toBeInTheDocument();
    await act(() => tauri.emitEvent("capture_state_changed", paused(2)));
    fireEvent.click(screen.getByRole("button", { name: "Resume recording" }));
    await waitFor(() => expect(called("capture_resume")).toBe(true));
  });

  it("names the button under the pointer in its own line, never a native title", async () => {
    setup(recording());
    const pause = await screen.findByRole("button", { name: "Pause recording" });
    fireEvent.mouseEnter(pause);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pause recording");
    // The line follows the button's label as it changes under the pointer.
    await act(() => tauri.emitEvent("capture_state_changed", paused(2)));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Resume recording");
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("is one Tab stop, and the arrow keys move along it", async () => {
    setup(recording());
    const small = await screen.findByRole("button", { name: "Small camera" });
    const buttons = screen.getAllByRole("button");
    expect(buttons.filter((b) => b.tabIndex === 0)).toEqual([small]);
    small.focus();
    fireEvent.keyDown(small, { key: "ArrowLeft" });
    expect(screen.getByRole("button", { name: "Pause recording" })).toHaveFocus();
  });

  // The sizes are offered only where Rust offers them from the pill too.
  it("offers only pause where Rust offers no resizing", async () => {
    setup(recording(), { ...BUBBLE, resizeFromPill: false });
    await screen.findByRole("button", { name: "Pause recording" });
    expect(screen.queryByRole("button", { name: "Small camera" })).toBeNull();
  });

  it("shows nothing outside a recording, for the stage, or for a hidden bubble", async () => {
    const cases: [CapturePhaseEvent, CaptureCameraState][] = [
      [{ phase: "finalizing", seq: 1 }, BUBBLE],
      [recording(), { ...BUBBLE, shape: "stage", size: "full" }],
      [recording(), { ...BUBBLE, hidden: true }],
    ];
    for (const [phase, camera] of cases) {
      const { unmount } = setup(phase, camera);
      await waitFor(() => expect(called("capture_camera_context")).toBe(true));
      await act(async () => undefined);
      expect(screen.queryByRole("toolbar")).toBeNull();
      unmount();
      tauri.reset();
    }
  });

  it("goes away when the recording ends", async () => {
    setup(recording());
    await screen.findByRole("toolbar");
    await act(() => tauri.emitEvent("capture_state_changed", { phase: "finalizing", seq: 2 }));
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
