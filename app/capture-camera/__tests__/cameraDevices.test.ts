import { describe, expect, it } from "vitest";
import { camerasFrom, videoConstraints } from "../cameraDevices";

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
