import { describe, expect, it } from "vitest";
import { classifyCaptureRefusal } from "@/app/lib/capture/captureFlow";

const notReady = (subkind: string, message = "irrelevant") => ({ kind: "NotReady", subkind, message });

describe("classifyCaptureRefusal", () => {
  it("sends a missing macOS permission to the permission explainer", () => {
    expect(classifyCaptureRefusal(notReady("SCREEN_RECORDING_PERMISSION"))).toEqual({ next: "grant-permission" });
  });

  // The match is on the subkind: a reworded Rust message must not turn a
  // dialog into a bare toast, and an unrelated NotReady must not open one.
  it("matches the subkind, not the message", () => {
    expect(
      classifyCaptureRefusal(notReady("SCREEN_RECORDING_PERMISSION", "Something else entirely")),
    ).toEqual({ next: "grant-permission" });
    expect(classifyCaptureRefusal(notReady("SYNC_SETUP", "Choose where your captures should be saved first."))).toEqual({
      next: "show-error",
      message: "Choose where your captures should be saved first.",
    });
  });

  it("shows anything else as Rust worded it", () => {
    expect(classifyCaptureRefusal({ kind: "Validation", message: "That window has closed." })).toEqual({
      next: "show-error",
      message: "That window has closed.",
    });
  });
});
