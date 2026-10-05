import { describe, expect, it } from "vitest";
import type { CaptureSupport } from "@/app/lib/tauri/capture";
import { RECORDING_UNAVAILABLE_REASON } from "@/app/lib/capture/recordAvailability";
import { trayCaptureView } from "../trayCaptureView";

function support(overrides: Partial<CaptureSupport> = {}): CaptureSupport {
  return {
    supported: true,
    recording: true,
    cameraOnly: true,
    screenRecordingPermission: true,
    permissionPane: null,
    recordingUnavailable: null,
    recordingUnavailableMessage: null,
    selection: "overlay",
    modes: { screenshot: ["area", "window", "screen"], recording: ["area", "window", "screen"] },
    screenshotTimer: true,
    recordCountdown: true,
    systemAudio: true,
    microphoneUnavailableMessage: null,
    continuityHint: null,
    shortcut: { supported: true, via: "plugin", unavailableMessage: null },
    systemPickerNote: null,
    linuxSession: null,
    ...overrides,
  };
}

describe("trayCaptureView", () => {
  it("is hidden while the lane has capture off, whatever Rust says", () => {
    expect(trayCaptureView(false, support(), true)).toEqual({ state: "hidden" });
    expect(trayCaptureView(false, undefined, true)).toEqual({ state: "hidden" });
  });

  it("loads until Rust answers, then hides where it cannot capture or could not say", () => {
    expect(trayCaptureView(true, undefined, true)).toEqual({ state: "loading" });
    expect(trayCaptureView(true, null, true)).toEqual({ state: "hidden" });
    expect(trayCaptureView(true, support({ supported: false }), true)).toEqual({ state: "hidden" });
  });

  it("offers Rust's modes in the menu's order", () => {
    const view = trayCaptureView(
      true,
      support({ modes: { screenshot: ["screen", "area"], recording: ["screen"] } }),
      true,
    );
    expect(view).toMatchObject({
      state: "ready",
      screenshotModes: ["area", "screen"],
      recordModes: ["screen"],
      record: { state: "available" },
      systemPicker: false,
    });
  });

  it("dims Record with Rust's reason, or the generic one on a Mac, and drops it elsewhere", () => {
    const helperMissing = trayCaptureView(
      true,
      support({
        recording: false,
        recordingUnavailable: "helperMissing",
        recordingUnavailableMessage: "Screen recording isn't included in this build.",
      }),
      true,
    );
    expect(helperMissing).toMatchObject({
      record: { state: "disabled", reason: "Screen recording isn't included in this build." },
    });
    expect(trayCaptureView(true, support({ recording: false }), true)).toMatchObject({
      record: { state: "disabled", reason: RECORDING_UNAVAILABLE_REASON },
    });
    const noRecorder = support({
      recording: false,
      recordingUnavailable: "unsupportedPlatform",
      recordingUnavailableMessage: "Screen recording isn't available on this system yet.",
    });
    expect(trayCaptureView(true, noRecorder, false)).toMatchObject({ record: { state: "hidden" } });
  });

  it("drops a Record with no mode to offer", () => {
    const view = trayCaptureView(true, support({ modes: { screenshot: ["area"], recording: [] } }), true);
    expect(view).toMatchObject({ record: { state: "hidden" } });
  });

  it("says when the desktop's own tool chooses (Wayland)", () => {
    const note = "Your desktop's screenshot tool chooses what to capture.";
    const view = trayCaptureView(true, support({ selection: "systemPicker", systemPickerNote: note }), false);
    expect(view).toMatchObject({ systemPicker: true, systemPickerNote: note });
  });
});
