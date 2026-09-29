import { describe, expect, it } from "vitest";
import { recordingTrayTitle, trayClickStopsRecording } from "../trayCaptureState";

describe("the menu bar during a recording", () => {
  it("shows the time while recording or paused, and nothing otherwise", () => {
    expect(recordingTrayTitle({ phase: "recording", elapsedSecs: 42, microphone: true })).toBe("◼ 00:42");
    expect(recordingTrayTitle({ phase: "paused", elapsedSecs: 125, microphone: false })).toBe("❚❚ 02:05");
    expect(recordingTrayTitle({ phase: "idle" })).toBeNull();
    expect(recordingTrayTitle({ phase: "finalizing" })).toBeNull();
  });

  it("turns the icon into Stop only while a recording is live", () => {
    expect(trayClickStopsRecording({ phase: "recording", elapsedSecs: 1, microphone: false })).toBe(true);
    expect(trayClickStopsRecording({ phase: "paused", elapsedSecs: 1, microphone: false })).toBe(true);
    expect(trayClickStopsRecording({ phase: "selecting", kind: "recording", mode: "area" })).toBe(false);
    expect(trayClickStopsRecording({ phase: "delivering", kind: "recording" })).toBe(false);
  });
});
