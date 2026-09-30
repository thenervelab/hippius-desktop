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
import { cameraCloseLabel, nextRoundSize, sizeControls, stripShown } from "../cameraDevices";

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
  tauri.onInvoke("capture_camera_set_size", (args) => (args as { size: string }).size);
  tauri.onInvoke("capture_cancel", () => null);
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

const sizeCalls = () =>
  tauri.core.invoke.mock.calls.filter(([c]) => c === "capture_camera_set_size").map(([, a]) => (a as { size: string }).size);

describe("the size toggle", () => {
  it("draws each button for what it does, in every size", () => {
    const at = (size: "small" | "large" | "full", last: "small" | "large" = "small") =>
      sizeControls(size, last).map((c) => [c.label, c.icon, c.pressed, c.target]);
    expect(at("small")).toEqual([
      ["Small camera", "small", true, "small"],
      ["Large camera", "large", false, "large"],
      ["Full size camera", "enterFull", false, "full"],
    ]);
    expect(at("large")).toEqual([
      ["Small camera", "small", false, "small"],
      ["Large camera", "large", true, "large"],
      ["Full size camera", "enterFull", false, "full"],
    ]);
    // Full: the third button leaves full size, back to the size from before.
    expect(at("full", "large")[2]).toEqual(["Exit full size", "exitFull", undefined, "large"]);
    expect(at("full", "small")[2]).toEqual(["Exit full size", "exitFull", undefined, "small"]);
    expect(nextRoundSize("large", "small")).toBe("large");
    expect(nextRoundSize("full", "large")).toBe("large");
  });

  it("goes small, large, full and back to the size it left", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Large camera" }));
    await act(() => tauri.emitEvent("capture_camera_state", { ...BUBBLE, size: "large" }));
    expect(screen.getByRole("button", { name: "Large camera" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Full size camera" }));
    await act(() => tauri.emitEvent("capture_camera_state", { ...BUBBLE, size: "full" }));
    // Full size is left from the same place, and the strip is still there.
    expect(screen.queryByRole("button", { name: "Full size camera" })).toBeNull();
    const exit = screen.getByRole("button", { name: "Exit full size" });
    expect(exit).toHaveAttribute("tabindex", "0");
    fireEvent.click(exit);
    await act(() => tauri.emitEvent("capture_camera_state", { ...BUBBLE, size: "large" }));
    fireEvent.click(screen.getByRole("button", { name: "Small camera" }));
    expect(sizeCalls()).toEqual(["large", "full", "large", "small"]);
  });

  it("leaves full size from small too, and every size keeps the whole strip", async () => {
    setup({ ...BUBBLE, size: "small" });
    await screen.findByRole("button", { name: "Full size camera" });
    await act(() => tauri.emitEvent("capture_camera_state", { ...BUBBLE, size: "full" }));
    for (const name of ["Small camera", "Large camera", "Exit full size", "Turn camera off"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    // Shown on hover, it takes clicks above the picture.
    await act(() => tauri.emitEvent("capture_camera_hover", true));
    const strip = screen.getByRole("toolbar", { name: "Camera size" });
    expect(strip.className).toContain("pointer-events-auto");
    expect(strip.parentElement?.className).toContain("z-10");
    fireEvent.click(screen.getByRole("button", { name: "Exit full size" }));
    expect(sizeCalls()).toEqual(["small"]);
  });

  it("leaves full size on Escape instead of cancelling", async () => {
    setup({ ...BUBBLE, size: "large" });
    await screen.findByRole("button", { name: "Full size camera" });
    await act(() => tauri.emitEvent("capture_camera_state", { ...BUBBLE, size: "full" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(sizeCalls()).toEqual(["large"]);
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_state");
  });

  it("still cancels on Escape at a round size", async () => {
    setup();
    await screen.findByRole("button", { name: "Full size camera" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_cancel"));
    expect(sizeCalls()).toEqual([]);
  });

  it("names the button under the pointer without a native title", async () => {
    setup();
    const full = await screen.findByRole("button", { name: "Full size camera" });
    fireEvent.mouseEnter(full);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Full size camera");
    expect(full).toHaveAttribute("aria-describedby", "camera-strip-tip");
    fireEvent.mouseLeave(full);
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent("");
    expect(document.querySelector("[title]")).toBeNull();
  });
});

describe("the camera picture", () => {
  const stream = { getTracks: () => [], getVideoTracks: () => [] };
  let play: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: vi.fn(async () => []),
        getUserMedia: vi.fn(async () => stream),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  // Mirrored, WebKit's own play button on a paused video pointed backwards.
  it("stays hidden until it plays, and hides again when paused", async () => {
    const { container } = setup();
    await waitFor(() => expect(container.querySelector("video")?.srcObject).toBe(stream));
    const video = container.querySelector("video")!;
    expect(video.className).toContain("opacity-0");
    expect(video.className).toContain("-scale-x-100");
    fireEvent(video, new Event("playing"));
    expect(video.className).toContain("opacity-100");
    fireEvent(video, new Event("pause"));
    expect(video.className).toContain("opacity-0");
    // The page starts it itself, on the new stream and after a pause.
    expect(play.mock.calls.length).toBeGreaterThanOrEqual(2);
    play.mockRestore();
  });
});
