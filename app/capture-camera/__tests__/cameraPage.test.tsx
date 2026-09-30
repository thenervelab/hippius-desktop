import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { CaptureCameraState, CapturePhase } from "@/app/lib/tauri/capture";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

import CaptureCameraPage from "../page";
import { cameraCloseLabel, stripShown } from "../cameraDevices";

const BUBBLE: CaptureCameraState = { shape: "bubble", hidden: false, deviceId: null, deviceName: null, size: "small" };

function setup(phase: CapturePhase, camera: CaptureCameraState | Promise<CaptureCameraState> = BUBBLE) {
  tauri.onInvoke("capture_camera_context", () => camera);
  tauri.onInvoke("capture_state", () => phase);
  tauri.onInvoke("capture_camera_set_size", () => "large");
  tauri.onInvoke("capture_camera_dismiss", () => null);
  return render(<CaptureCameraPage />);
}

beforeEach(() => tauri.reset());

describe("the camera bubble's size strip", () => {
  it("is in the page while choosing, faded until hovered or focused, and reachable by Tab", async () => {
    setup({ phase: "selecting", kind: "recording", mode: "screen" });
    const strip = await screen.findByRole("toolbar", { name: "Camera size" });
    expect(strip.className).toContain("opacity-0");
    expect(strip.className).toContain("focus-within:opacity-100");
    expect(screen.getByRole("button", { name: "Small camera" })).toHaveAttribute("tabindex", "0");
    // No native tooltip: this window is filmed.
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("shows on hover (Rust reports it: the window is never key)", async () => {
    setup({ phase: "selecting", kind: "recording", mode: "screen" });
    const strip = await screen.findByRole("toolbar", { name: "Camera size" });
    await act(() => tauri.emitEvent("capture_camera_hover", true));
    expect(strip.className).toContain("opacity-100");
    expect(strip.className).not.toContain("pointer-events-none");
  });

  // The camera window is filmed; a strip under the pointer mid-recording was
  // in the video.
  it("is gone while recording", async () => {
    setup({ phase: "recording", elapsedSecs: 4, microphone: false });
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_state"));
    await act(() => tauri.emitEvent("capture_camera_hover", true));
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("goes when recording starts", async () => {
    setup({ phase: "selecting", kind: "recording", mode: "screen" });
    await screen.findByRole("toolbar", { name: "Camera size" });
    await act(() => tauri.emitEvent("capture_state_changed", { phase: "capturing", kind: "recording" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("moves along the sizes with the arrow keys and calls the × what it does", async () => {
    setup({ phase: "selecting", kind: "recording", mode: "screen" });
    const strip = await screen.findByRole("toolbar", { name: "Camera size" });
    screen.getByRole("button", { name: "Small camera" }).focus();
    fireEvent.keyDown(strip, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Large camera" })).toHaveFocus();
    fireEvent.keyDown(strip, { key: "End" });
    expect(screen.getByRole("button", { name: "Turn camera off" })).toHaveFocus();
  });

  it("names the × by phase", () => {
    expect(cameraCloseLabel({ phase: "selecting", kind: "recording", mode: "area" })).toBe("Turn camera off");
    expect(cameraCloseLabel({ phase: "paused", elapsedSecs: 1, microphone: false })).toBe("Hide camera");
    expect(stripShown(null)).toBe(false);
  });
});

describe("the camera window's first read", () => {
  // The context can answer late (it may start the helper to name the camera).
  it("gives way to an event that arrived first", async () => {
    let answer: (c: CaptureCameraState) => void = () => undefined;
    setup(
      { phase: "selecting", kind: "recording", mode: "screen" },
      new Promise<CaptureCameraState>((r) => (answer = r)),
    );
    await act(() => tauri.emitEvent("capture_camera_state", { ...BUBBLE, size: "large" }));
    await act(async () => answer({ ...BUBBLE, shape: null }));
    expect(await screen.findByRole("button", { name: "Large camera" })).toHaveAttribute("aria-pressed", "true");
  });
});
