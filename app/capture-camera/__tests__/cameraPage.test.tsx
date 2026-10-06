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
  recorderOwnsCamera: false,
  switchFromPill: false,
  resizeFromPill: false,
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

// The bubble's window has no height on <html>/<body>: a root sized
// `h-full` took the camera's 16:9 picture as its height and drew the round
// bubble as a pill. jsdom does no layout, so the classes that make the
// shape are what is pinned; the layout itself was checked in a browser.
describe("the camera frame's shape", () => {
  const frameClasses = () => screen.getByTestId("camera-frame").className.split(/\s+/);

  it("is sized by the window, not by the video", async () => {
    setup();
    const root = await screen.findByTestId("camera-window");
    expect(root.className).toContain("fixed inset-0");
    expect(root.className).not.toMatch(/(^|\s)h-full(\s|$)/);
  });

  it.each(["small", "large"] as const)("is a square circle at %s size", async (size) => {
    setup({ ...BUBBLE, size });
    await screen.findByTestId("camera-frame");
    expect(frameClasses()).toEqual(expect.arrayContaining(["aspect-square", "rounded-full", "overflow-hidden"]));
    // Never stretched to the window's height on its own: that is the oval.
    expect(frameClasses()).not.toContain("h-full");
  });

  it("fills its 16:9 window with rounded corners at full size and as the stage", async () => {
    const { unmount } = setup({ ...BUBBLE, size: "full" });
    await screen.findByTestId("camera-frame");
    expect(frameClasses()).toEqual(expect.arrayContaining(["h-full", "w-full", "rounded-[18px]"]));
    expect(frameClasses()).not.toContain("aspect-square");
    unmount();

    setup({ ...BUBBLE, shape: "stage", size: "small" });
    await screen.findByTestId("camera-frame");
    expect(frameClasses()).toEqual(expect.arrayContaining(["h-full", "w-full", "rounded-[18px]"]));
  });

  it("turns round again when it leaves full size", async () => {
    setup({ ...BUBBLE, size: "full" });
    await screen.findByTestId("camera-frame");
    await act(() => tauri.emitEvent("capture_camera_state", { ...BUBBLE, size: "large" }));
    expect(frameClasses()).toEqual(expect.arrayContaining(["aspect-square", "rounded-full"]));
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
    // Cropped to fill the round frame, centred, never letterboxed or stretched.
    expect(video.className).toContain("object-cover");
    fireEvent(video, new Event("playing"));
    expect(video.className).toContain("opacity-100");
    fireEvent(video, new Event("pause"));
    expect(video.className).toContain("opacity-0");
    // The page starts it itself, on the new stream and after a pause.
    expect(play.mock.calls.length).toBeGreaterThanOrEqual(2);
    play.mockRestore();
  });
});

describe("the camera while it starts or is taken away", () => {
  type Listener = () => void;
  const makeStream = () => {
    const listeners: Record<string, Listener[]> = {};
    const track = {
      muted: false,
      readyState: "live",
      stop: vi.fn(),
      getSettings: () => ({}),
      addEventListener: (name: string, fn: Listener) => (listeners[name] ??= []).push(fn),
      fire(name: string) {
        for (const fn of listeners[name] ?? []) fn();
      },
    };
    return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } };
  };
  let getUserMedia: ReturnType<typeof vi.fn>;
  let play: ReturnType<typeof vi.spyOn>;
  let first: ReturnType<typeof makeStream>;

  beforeEach(() => {
    play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    first = makeStream();
    let calls = 0;
    getUserMedia = vi.fn(async () => (++calls === 1 ? first.stream : makeStream().stream));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: vi.fn(async () => []),
        getUserMedia,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  // The bubble is filmed: before the first frame it must not be a black disc.
  it("shows a placeholder, not black, until the first frame plays", async () => {
    const { container } = setup();
    await waitFor(() => expect(container.querySelector("video")?.srcObject).toBe(first.stream));
    expect(screen.getByTestId("camera-starting")).toBeInTheDocument();
    fireEvent(container.querySelector("video")!, new Event("playing"));
    expect(screen.queryByTestId("camera-starting")).toBeNull();
    play.mockRestore();
  });

  /**
   * WebKit mutes this page's camera when another page starts capturing, and
   * it stays black until the camera is asked for again.
   */
  it("covers a muted camera and opens it again when it stays muted", async () => {
    const { container } = setup();
    await waitFor(() => expect(container.querySelector("video")?.srcObject).toBe(first.stream));
    const video = container.querySelector("video")!;
    fireEvent(video, new Event("playing"));
    expect(screen.queryByTestId("camera-starting")).toBeNull();

    first.track.muted = true;
    act(() => first.track.fire("mute"));
    expect(screen.getByTestId("camera-starting")).toBeInTheDocument();
    expect(video.className).toContain("opacity-0");

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await waitFor(() => expect(container.querySelector("video")?.srcObject).not.toBe(first.stream));
    expect(first.track.stop).toHaveBeenCalled();
    play.mockRestore();
  });

  it("leaves a camera that unmutes on its own alone", async () => {
    const { container } = setup();
    await waitFor(() => expect(container.querySelector("video")?.srcObject).toBe(first.stream));
    fireEvent(container.querySelector("video")!, new Event("playing"));
    first.track.muted = true;
    act(() => first.track.fire("mute"));
    first.track.muted = false;
    act(() => first.track.fire("unmute"));
    expect(screen.queryByTestId("camera-starting")).toBeNull();
    await new Promise((r) => setTimeout(r, 1800));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    play.mockRestore();
  });
});

// Camera only on Wayland: the recorder opens the camera itself, so this
// page must let go of it the moment Rust says so (one owner per device),
// and shows a placeholder instead of a black or frozen picture.
describe("the stage when the recorder has the camera", () => {
  const STAGE: CaptureCameraState = { ...BUBBLE, shape: "stage", size: "full" };
  let stop: ReturnType<typeof vi.fn>;
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    stop = vi.fn();
    const track = { muted: false, readyState: "live", stop, getSettings: () => ({}), addEventListener: vi.fn() };
    getUserMedia = vi.fn(async () => ({ getTracks: () => [track], getVideoTracks: () => [track] }));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: vi.fn(async () => []), getUserMedia, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
  });

  it("closes its own stream and says the camera is being recorded", async () => {
    setup(STAGE);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    await act(() => tauri.emitEvent("capture_camera_state", { ...STAGE, recording: true, recorderOwnsCamera: true }));
    await waitFor(() => expect(stop).toHaveBeenCalled());
    expect(screen.getByTestId("camera-handed-over")).toHaveTextContent("Recording your camera");
    expect(document.querySelector("video")).toBeNull();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("never opens the camera while the recorder has it", async () => {
    setup({ ...STAGE, recording: true, recorderOwnsCamera: true });
    await screen.findByTestId("camera-handed-over");
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});


// The pill switches the camera mid-recording (`capture_camera_switch`): Rust
// sends the new device in the camera state and this page, the only one that
// may open a camera, opens it. The window keeps recording all along.
describe("a camera switched mid-recording", () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  const cameras = [
    { kind: "videoinput", deviceId: "web-facetime", label: "FaceTime HD Camera", groupId: "" },
    { kind: "videoinput", deviceId: "web-phone", label: "Ahmad’s iPhone Camera", groupId: "" },
  ];

  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    getUserMedia = vi.fn(async () => {
      const track = { muted: false, readyState: "live", stop: vi.fn(), getSettings: () => ({}), addEventListener: vi.fn() };
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: vi.fn(async () => cameras), getUserMedia, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    tauri.onInvoke("capture_set_cameras", () => null);
  });

  it("opens the newly chosen camera by name and stays a recording bubble", async () => {
    setup({ ...RECORDING, deviceId: "1F06", deviceName: "FaceTime HD Camera" });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(getUserMedia.mock.calls[0][0])).toContain("web-facetime");
    await act(() =>
      tauri.emitEvent("capture_camera_state", { ...RECORDING, deviceId: "9160", deviceName: "Ahmad's iPhone Camera" }),
    );
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(getUserMedia.mock.calls[1][0])).toContain("web-phone");
    // No size strip appears: it would be filmed.
    expect(screen.queryByRole("toolbar", { name: "Camera size" })).toBeNull();
  });
});
