import { describe, expect, it } from "vitest";
import {
  describeConstraints,
  describeDevices,
  describeError,
  describeMediaSupport,
  describeTrack,
  describeVideo,
  shortId,
} from "../cameraReport";
import { exactCameraConstraints, videoConstraints } from "../cameraDevices";

/**
 * What the camera page sends to the app log when the bubble stays on its
 * placeholder: enough to say where opening the camera stopped, and nothing
 * about the user beyond device names.
 */
describe("the camera page's reports", () => {
  it("names the cameras WebKit listed and never logs a whole device id", () => {
    const id = "4f1c0b9e2d7a6c3b5e8f0a1d2c3b4a59";
    const text = describeDevices([
      { kind: "audioinput", deviceId: "m", label: "Built-in Audio" },
      { kind: "videoinput", deviceId: id, label: "Integrated Camera: Integrated C" },
      { kind: "videoinput", deviceId: "b2", label: "" },
    ]);
    expect(text).toBe('2 cameras: "Integrated Camera: Integrated C", (unnamed b2)');
    expect(describeDevices([])).toBe("no cameras listed");
    expect(shortId(id)).toBe("4f1c0b9e...");
    expect(describeConstraints(videoConstraints(id))).toBe("deviceId ideal 4f1c0b9e..., size 1280x720, fps 30");
    expect(describeConstraints(exactCameraConstraints(id))).toBe("deviceId exact 4f1c0b9e..., size 1280x720, fps 30");
    expect(describeConstraints(videoConstraints(null))).toBe("default camera, size 1280x720, fps 30");
  });

  it("says which error getUserMedia gave, with its message and constraint", () => {
    expect(describeError({ name: "NotReadableError", message: "Failed starting capture of a video track" })).toBe(
      "NotReadableError: Failed starting capture of a video track",
    );
    expect(describeError({ name: "OverconstrainedError", message: "", constraint: "deviceId" })).toBe(
      "OverconstrainedError: (no message) (constraint deviceId)",
    );
    expect(describeError("boom")).toBe("thrown: boom");
  });

  it("describes the track and the video, even from an engine that says little", () => {
    expect(
      describeTrack({
        label: "Integrated Camera",
        readyState: "live",
        muted: false,
        enabled: true,
        getSettings: () => ({ width: 640, height: 480, frameRate: 29.97 }),
      }),
    ).toBe('"Integrated Camera" live muted=false enabled=true 640x480@30');
    expect(
      describeTrack({
        readyState: "live",
        muted: true,
        getSettings: () => {
          throw new Error("no");
        },
      }),
    ).toBe("(no label) live muted=true enabled=undefined");
    expect(describeTrack(undefined)).toBe("no track");
    expect(describeVideo({ readyState: 0, paused: true, videoWidth: 0, videoHeight: 0, srcObject: {} })).toBe(
      "video readyState=0 paused=true size=0x0 stream=yes",
    );
    expect(describeVideo(null)).toBe("no video element");
  });

  it("says whether the webview offers getUserMedia at all", () => {
    expect(describeMediaSupport({}, true, "tauri://localhost")).toBe(
      "navigator.mediaDevices missing; secure context true; origin tauri://localhost",
    );
    expect(describeMediaSupport({ mediaDevices: {} }, false, "x")).toContain("present without getUserMedia");
  });
});
