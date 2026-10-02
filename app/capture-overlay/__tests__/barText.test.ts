import { describe, expect, it } from "vitest";
import {
  barGroups,
  barHint,
  chooseLabel,
  confirmLabel,
  isDeviceInUse,
  panelHint,
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
  systemAudio: false,
  lastKind: "recording",
  lastMode: "screen",
  copyLink: true,
  recordCountdownSecs: 3,
};

describe("the capture bar", () => {
  it("offers screenshots everywhere and recordings only where they work", () => {
    expect(barGroups(false)).toHaveLength(1);
    const [shots, recordings] = barGroups(true);
    expect(shots.map((m) => m.mode)).toEqual(["screen", "window", "area"]);
    expect(recordings.every((m) => m.kind === "recording")).toBe(true);
    // One vocabulary with the Drive Capture menu: area, window, entire screen.
    expect(recordings.map((m) => m.label)).toEqual(["Record entire screen", "Record a window", "Record an area"]);
    expect(shots.map((m) => m.label)).toEqual(["Capture entire screen", "Capture a window", "Capture an area"]);
  });

  // A local build without the helper used to drop the Record group, so the
  // feature vanished with no word why.
  it("shows the Record modes disabled, with the reason, on a Mac that cannot record in this build", () => {
    const note = "Screen recording isn't included in this build.";
    const [shots, recordings] = barGroups(false, note);
    expect(shots.every((m) => m.unavailable === undefined)).toBe(true);
    expect(recordings.map((m) => m.label)).toEqual(["Record entire screen", "Record a window", "Record an area"]);
    expect(recordings.every((m) => m.unavailable === note)).toBe(true);
    expect(barGroups(false, null)).toHaveLength(1);
    expect(barGroups(true, note)[1].every((m) => m.unavailable === undefined)).toBe(true);
  });

  // Rust says which modes each kind may offer (a Wayland recording has no
  // area in v1); the bar draws only those, in its own order.
  it("draws only the modes Rust offers, and drops a group left with none", () => {
    const [shots, recordings] = barGroups(true, null, {
      screenshot: ["area", "screen", "window"],
      recording: ["window", "screen"],
    });
    expect(shots.map((m) => m.mode)).toEqual(["screen", "window", "area"]);
    expect(recordings.map((m) => m.mode)).toEqual(["screen", "window"]);
    const onlyShots = barGroups(true, null, { screenshot: ["area"], recording: [] });
    expect(onlyShots).toHaveLength(1);
    expect(onlyShots[0].map((m) => m.label)).toEqual(["Capture an area"]);
    const disabled = barGroups(false, "Screen recording needs video codecs.", { screenshot: ["area"], recording: ["screen"] });
    expect(disabled[1].map((m) => [m.mode, m.unavailable])).toEqual([["screen", "Screen recording needs video codecs."]]);
  });

  it("names the Choose button for what it lists", () => {
    expect(chooseLabel("window")).toBe("Choose window…");
    expect(chooseLabel("screen")).toBe("Choose screen…");
    expect(chooseLabel("area")).toBe("Choose screen…");
  });

  it("says Capture or Record on its button", () => {
    expect(confirmLabel("screenshot")).toBe("Capture");
    expect(confirmLabel("recording")).toBe("Record");
  });

  it("tells the user the next step for each mode", () => {
    expect(barHint("screenshot", "area", false)).toBe("Drag to choose what to capture");
    expect(barHint("recording", "area", true)).toBe(
      "Drag or use the arrow keys to adjust, then double-click or press Return to record",
    );
    expect(barHint("recording", "window", false)).toBe("Click a window to record it");
    expect(barHint("screenshot", "screen", false)).toContain("press Return");
  });

  it("names the confirm key as the platform does", () => {
    expect(barHint("screenshot", "screen", false, false, "Enter")).toBe("Click a screen to capture it, or press Enter");
    expect(barHint("recording", "area", false, true, "Enter")).toContain("press Enter to record");
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

describe("the panel's line (the desktop's dialog chooses)", () => {
  it("says Record leads to the desktop's dialog, for what the mode records", () => {
    expect(panelHint("window", "Enter")).toBe("Press Record or Enter, then choose a window in your desktop's sharing dialog");
    expect(panelHint("screen", "Enter")).toBe("Press Record or Enter, then choose a screen in your desktop's sharing dialog");
    expect(panelHint("screen")).not.toMatch(/Click/);
    // An area is drawn after the dialog, on the chosen screen's picture.
    expect(panelHint("area", "Enter")).toBe(
      "Press Record or Enter, choose a screen in your desktop's sharing dialog, then drag the area to record",
    );
    // Camera only asks no dialog: the recorder opens the camera itself.
    expect(panelHint("screen", "Enter", true)).toBe("Press Record or Enter to record your camera");
  });
});
