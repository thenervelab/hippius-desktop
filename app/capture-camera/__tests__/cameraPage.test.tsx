import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { CaptureCameraState } from "@/app/lib/tauri/capture";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

import CaptureCameraPage from "../page";
import { cameraCloseLabel, stripShown } from "../cameraDevices";

const BUBBLE: CaptureCameraState = {
  shape: "bubble",
  hidden: false,
  deviceId: null,
  deviceName: null,
  size: "small",
  recording: false,
  cameraFilmed: true,
};
const RECORDING: CaptureCameraState = { ...BUBBLE, recording: true };

function setup(camera: CaptureCameraState | Promise<CaptureCameraState> = BUBBLE) {
  tauri.onInvoke("capture_camera_context", () => camera);
  tauri.onInvoke("capture_state", () => ({ phase: "selecting", kind: "recording", mode: "screen", seq: 1 }));
  tauri.onInvoke("capture_camera_set_size", () => "large");
  tauri.onInvoke("capture_camera_dismiss", () => null);
  return render(<CaptureCameraPage />);
}

beforeEach(() => tauri.reset());

describe("the camera bubble's size strip", () => {
  it("is in the page while choosing, faded until hovered or focused, and reachable by Tab", async () => {
    setup();
    const strip = await screen.findByRole("toolbar", { name: "Camera size" });
    expect(strip.className).toContain("opacity-0");
    expect(strip.className).toContain("focus-within:opacity-100");
    expect(screen.getByRole("button", { name: "Small camera" })).toHaveAttribute("tabindex", "0");
    // No native tooltip: this window is filmed.
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("shows on hover (Rust reports it: the window is never key)", async () => {
    setup();
    const strip = await screen.findByRole("toolbar", { name: "Camera size" });
    await act(() => tauri.emitEvent("capture_camera_hover", true));
    expect(strip.className).toContain("opacity-100");
    expect(strip.className).not.toContain("pointer-events-none");
  });

  // The camera window is filmed; a strip under the pointer mid-recording was
  // in the video.
  it("is gone while recording", async () => {
    setup(RECORDING);
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_camera_context"));
    await act(() => tauri.emitEvent("capture_camera_hover", true));
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  // Rust's camera state says a recording is starting; the page follows no phase.
  it("goes when recording starts", async () => {
    setup();
    await screen.findByRole("toolbar", { name: "Camera size" });
    await act(() => tauri.emitEvent("capture_camera_state", RECORDING));
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(tauri.event.listen.mock.calls.some(([e]) => e === "capture_state_changed")).toBe(false);
  });

  it("moves along the sizes with the arrow keys and calls the × what it does", async () => {
    setup();
    const strip = await screen.findByRole("toolbar", { name: "Camera size" });
    screen.getByRole("button", { name: "Small camera" }).focus();
    fireEvent.keyDown(strip, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Large camera" })).toHaveFocus();
    fireEvent.keyDown(strip, { key: "End" });
    expect(screen.getByRole("button", { name: "Turn camera off" })).toHaveFocus();
  });

  it("names the × for what it does, and draws the strip only on a bubble while choosing", () => {
    expect(cameraCloseLabel(BUBBLE)).toBe("Turn camera off");
    expect(cameraCloseLabel(RECORDING)).toBe("Hide camera");
    expect(stripShown(null)).toBe(false);
    expect(stripShown(BUBBLE)).toBe(true);
    expect(stripShown(RECORDING)).toBe(false);
    expect(stripShown({ ...BUBBLE, shape: "stage" })).toBe(false);
  });
});

describe("the camera window's first read", () => {
  // The context can answer late (it may start the helper to name the camera).
  it("gives way to an event that arrived first", async () => {
    let answer: (c: CaptureCameraState) => void = () => undefined;
    setup(new Promise<CaptureCameraState>((r) => (answer = r)));
    await act(() => tauri.emitEvent("capture_camera_state", { ...BUBBLE, size: "large" }));
    await act(async () => answer({ ...BUBBLE, shape: null }));
    expect(await screen.findByRole("button", { name: "Large camera" })).toHaveAttribute("aria-pressed", "true");
  });
});
