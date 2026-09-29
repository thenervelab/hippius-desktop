import { describe, expect, it } from "vitest";
import {
  barGroups,
  barHint,
  confirmLabel,
  isDeviceInUse,
  pickCamera,
  pickMicrophone,
  shareTabFor,
  sourceLabel,
  TIMER_OPTIONS,
  toggleScreen,
} from "@/app/capture-overlay/barText";
import type { CaptureOptions } from "@/app/lib/tauri/capture";

const OPTIONS: CaptureOptions = {
  timerSecs: 0,
  microphone: false,
  microphoneDevice: null,
  screen: true,
  camera: false,
  cameraDevice: null,
  cameraSize: "small",
  showClicks: false,
  lastKind: "recording",
  lastMode: "screen",
};

describe("the capture bar", () => {
  it("offers screenshots everywhere and recordings only where they work", () => {
    expect(barGroups(false)).toHaveLength(1);
    const [shots, recordings] = barGroups(true);
    expect(shots.map((m) => m.mode)).toEqual(["screen", "window", "area"]);
    expect(recordings.every((m) => m.kind === "recording")).toBe(true);
    expect(recordings.map((m) => m.label)).toContain("Record selected portion");
  });

  it("says Capture or Record on its button", () => {
    expect(confirmLabel("screenshot")).toBe("Capture");
    expect(confirmLabel("recording")).toBe("Record");
  });

  it("tells the user the next step for each mode", () => {
    expect(barHint("screenshot", "area", false)).toBe("Drag to choose what to capture");
    expect(barHint("recording", "area", true)).toBe("Drag to adjust, then press Return to record");
    expect(barHint("recording", "window", false)).toBe("Click a window to record it");
    expect(barHint("screenshot", "screen", false)).toContain("press Return");
  });

  /** Rust snaps anything else to no timer (`bar::TIMER_CHOICES`). */
  it("offers only the timers Rust accepts", () => {
    expect(TIMER_OPTIONS.map((t) => t.secs)).toEqual([0, 5, 10]);
  });

  it("asks the user to place the camera when recording the camera alone", () => {
    expect(barHint("recording", "area", false, true)).toContain("camera");
    // A screenshot never records the camera, whatever is saved.
    expect(barHint("screenshot", "area", false, true)).toBe("Drag to choose what to capture");
  });
});

describe("the recording sources", () => {
  const cams = [
    { id: "cam1", name: "FaceTime HD Camera" },
    { id: "cam2", name: "Studio Display Camera" },
  ];

  it("names the chosen device, the default, or that the source is off", () => {
    expect(sourceLabel(true, "cam2", cams, "camera")).toBe("Studio Display Camera");
    expect(sourceLabel(true, null, cams, "camera")).toBe("Default camera");
    expect(sourceLabel(false, "cam2", cams, "camera")).toBe("No camera");
    expect(sourceLabel(false, null, [], "microphone")).toBe("No microphone");
  });

  it("reads an unplugged device as the default, which is what gets used", () => {
    expect(sourceLabel(true, "gone", cams, "camera")).toBe("Default camera");
  });

  /** The system marks its default microphone; the bar names it rather than "Default". */
  it("names the system default when nothing is chosen", () => {
    const mics = [
      { id: "BuiltIn", name: "MacBook Pro Microphone" },
      { id: "usb", name: "Yeti Stereo Microphone", isDefault: true },
    ];
    expect(sourceLabel(true, null, mics, "microphone")).toBe("Yeti Stereo Microphone");
    expect(sourceLabel(true, "gone", mics, "microphone")).toBe("Yeti Stereo Microphone");
    expect(isDeviceInUse(mics[1], null, mics)).toBe(true);
    expect(isDeviceInUse(mics[0], null, mics)).toBe(false);
    expect(isDeviceInUse(mics[0], "BuiltIn", mics)).toBe(true);
    // Unplugged: the check mark moves to what is actually used.
    expect(isDeviceInUse(mics[1], "gone", mics)).toBe(true);
    // No default marked: the first listed, as the system uses.
    expect(isDeviceInUse(cams[0], null, cams)).toBe(true);
  });

  it("opens the share picker on the tab for the bar's mode", () => {
    expect(shareTabFor("window")).toBe("window");
    expect(shareTabFor("screen")).toBe("screen");
    expect(shareTabFor("area")).toBe("screen");
  });

  it("turning the screen off records the camera alone", () => {
    const off = toggleScreen(OPTIONS);
    expect(off).toMatchObject({ screen: false, camera: true });
    expect(toggleScreen(off)).toMatchObject({ screen: true, camera: true });
  });

  /** Neither screen nor camera would record nothing. */
  it("turning the camera off while the screen is off brings the screen back", () => {
    expect(pickCamera({ ...OPTIONS, screen: false, camera: true }, null)).toMatchObject({ screen: true, camera: false });
  });

  it("picks a device, or the default, and turns the source on", () => {
    expect(pickCamera(OPTIONS, "cam1")).toMatchObject({ camera: true, cameraDevice: "cam1" });
    expect(pickCamera({ ...OPTIONS, cameraDevice: "cam1" }, "default")).toMatchObject({ camera: true, cameraDevice: null });
    expect(pickMicrophone(OPTIONS, "BuiltIn")).toMatchObject({ microphone: true, microphoneDevice: "BuiltIn" });
    expect(pickMicrophone({ ...OPTIONS, microphone: true }, null)).toMatchObject({ microphone: false });
  });
});
