import { describe, expect, it } from "vitest";
import { deviceIdByName } from "../devices";
import { mmss } from "../time";
import { cappedPercent } from "@/app/lib/upload-feed/percent";

describe("deviceIdByName", () => {
  const devices = [
    { kind: "audioinput" as const, deviceId: "default", label: "Default - MacBook Pro Microphone" },
    { kind: "audioinput" as const, deviceId: "a1", label: "MacBook Pro Microphone" },
    { kind: "audioinput" as const, deviceId: "a2", label: "Yeti Stereo Microphone (046d:0ab1)" },
    { kind: "videoinput" as const, deviceId: "v1", label: "Yeti Stereo Microphone" },
  ];

  it("finds the chosen microphone in the webview by its name, not the default alias", () => {
    expect(deviceIdByName(devices, "audioinput", "MacBook Pro Microphone")).toBe("a1");
  });

  it("matches a label the webview decorated with a USB id", () => {
    expect(deviceIdByName(devices, "audioinput", "Yeti Stereo Microphone")).toBe("a2");
  });

  it("never matches a device of the other kind", () => {
    expect(deviceIdByName(devices, "videoinput", "MacBook Pro Microphone")).toBeNull();
    expect(deviceIdByName(devices, "videoinput", "Yeti Stereo Microphone")).toBe("v1");
  });

  it("finds a Continuity iPhone whatever apostrophe or Unicode form each side used", () => {
    const iphone = [
      { kind: "videoinput" as const, deviceId: "v1", label: "FaceTime HD Camera" },
      { kind: "videoinput" as const, deviceId: "v2", label: "Ahmad\u2019s iPhone Camera" },
      { kind: "videoinput" as const, deviceId: "v3", label: "Ahmad\u2019s iPhone Desk View Camera" },
      { kind: "audioinput" as const, deviceId: "a1", label: "Ahmad's iPhone Microphone" },
      { kind: "audioinput" as const, deviceId: "a2", label: "Zo\u0065\u0301\u2019s  iPhone Microphone" },
    ];
    expect(deviceIdByName(iphone, "videoinput", "Ahmad's iPhone Camera")).toBe("v2");
    expect(deviceIdByName(iphone, "videoinput", "Ahmad\u2019s iPhone Camera")).toBe("v2");
    expect(deviceIdByName(iphone, "videoinput", "AHMAD\u2018S IPHONE DESK VIEW CAMERA")).toBe("v3");
    expect(deviceIdByName(iphone, "audioinput", "Ahmad\u2019s iPhone Microphone")).toBe("a1");
    // Decomposed "é" and a doubled space on the webview side; composed on the helper's.
    expect(deviceIdByName(iphone, "audioinput", "Zo\u00e9\u2019s iPhone Microphone")).toBe("a2");
  });

  it("ignores a name that is only whitespace", () => {
    expect(deviceIdByName(devices, "audioinput", "   ")).toBeNull();
  });

  it("opens the default when nothing is chosen or nothing matches", () => {
    expect(deviceIdByName(devices, "audioinput", "AirPods")).toBeNull();
    expect(deviceIdByName(devices, "audioinput", null)).toBeNull();
  });
});

describe("mmss", () => {
  it("reads as minutes and seconds past an hour too", () => {
    expect(mmss(0)).toBe("00:00");
    expect(mmss(125)).toBe("02:05");
    expect(mmss(3725)).toBe("62:05");
  });
});

describe("cappedPercent", () => {
  it("never says 100 before the upload says it is done", () => {
    expect(cappedPercent(999, 1000)).toBe(99);
    expect(cappedPercent(1000, 1000)).toBe(99);
  });

  it("is unknown while the size is unknown", () => {
    expect(cappedPercent(10, 0)).toBeNull();
  });
});
