import { describe, expect, it } from "vitest";
import {
  camerasAreNamed,
  camerasFrom,
  MUTE_RECOVERY_TRIES,
  resolveCameraId,
  shouldReopenMuted,
  showsPlaceholder,
  videoConstraints,
} from "../cameraDevices";

const dev = (kind: MediaDeviceKind, deviceId: string, label = "") => ({ kind, deviceId, label });

describe("camerasFrom", () => {
  it("lists cameras only, without the duplicate default entry", () => {
    expect(
      camerasFrom([
        dev("audioinput", "mic1", "MacBook Pro Microphone"),
        dev("videoinput", "default", "FaceTime HD Camera"),
        dev("videoinput", "cam1", "FaceTime HD Camera"),
        dev("videoinput", "cam2", "Studio Display Camera"),
      ]),
    ).toEqual([
      { id: "cam1", name: "FaceTime HD Camera" },
      { id: "cam2", name: "Studio Display Camera" },
    ]);
  });

  it("names a camera it cannot read the label of yet", () => {
    expect(camerasFrom([dev("videoinput", "cam1"), dev("videoinput", "cam2", "  ")])).toEqual([
      { id: "cam1", name: "Camera 1" },
      { id: "cam2", name: "Camera 2" },
    ]);
  });

  it("skips entries with no id (no permission yet)", () => {
    expect(camerasFrom([dev("videoinput", "")])).toEqual([]);
  });
});

describe("videoConstraints", () => {
  it("prefers the chosen camera without failing when it has gone", () => {
    expect(videoConstraints("cam2").deviceId).toEqual({ ideal: "cam2" });
  });

  it("asks for the default camera when none is chosen", () => {
    expect(videoConstraints(null).deviceId).toBeUndefined();
  });
});

describe("resolveCameraId", () => {
  const devices = [
    dev("videoinput", "default", "FaceTime HD Camera"),
    dev("videoinput", "w1", "FaceTime HD Camera"),
    dev("videoinput", "w2", "Studio Display Camera (05ac:1112)"),
  ];

  /** The bar lists the system's cameras, whose ids the webview never uses. */
  it("finds a system-listed camera by its name", () => {
    expect(resolveCameraId(devices, "0x1234AVCaptureId", "Studio Display Camera")).toBe("w2");
    expect(resolveCameraId(devices, "0x1234AVCaptureId", "FaceTime HD Camera")).toBe("w1");
  });

  /** The helper and WebKit can disagree on the phone name's apostrophe. */
  it("opens the iPhone the bar chose as a Continuity Camera, not the built-in camera", () => {
    const withPhone = [...devices, dev("videoinput", "w3", "Ahmad\u2019s iPhone Camera")];
    expect(resolveCameraId(withPhone, "A1B2-CONT", "Ahmad's iPhone Camera")).toBe("w3");
    expect(resolveCameraId(withPhone, "A1B2-CONT", "Ahmad\u2019s iPhone Camera".normalize("NFD"))).toBe("w3");
  });

  it("keeps a webview id chosen by an older build", () => {
    expect(resolveCameraId(devices, "w2", null)).toBe("w2");
  });

  it("falls back to the default when the camera is gone or unnamed", () => {
    expect(resolveCameraId(devices, "gone", "Continuity Camera")).toBeNull();
    expect(resolveCameraId([dev("videoinput", "w1")], "sys", "FaceTime HD Camera")).toBeNull();
    expect(resolveCameraId(devices, null, null)).toBeNull();
  });

  it("knows when the webview cannot name its cameras yet", () => {
    expect(camerasAreNamed([dev("videoinput", "w1")])).toBe(false);
    expect(camerasAreNamed(devices)).toBe(true);
  });
});

describe("a muted camera", () => {
  it("is opened again a bounded number of times", () => {
    expect(shouldReopenMuted(false, 0)).toBe(false);
    expect(shouldReopenMuted(true, 0)).toBe(true);
    expect(shouldReopenMuted(true, MUTE_RECOVERY_TRIES - 1)).toBe(true);
    expect(shouldReopenMuted(true, MUTE_RECOVERY_TRIES)).toBe(false);
  });

  it("shows the placeholder until it plays and while it is muted", () => {
    expect(showsPlaceholder(false, false)).toBe(true);
    expect(showsPlaceholder(true, true)).toBe(true);
    expect(showsPlaceholder(true, false)).toBe(false);
  });
});
