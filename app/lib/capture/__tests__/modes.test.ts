import { describe, expect, it } from "vitest";
import { disabledRecordingNote } from "@/app/lib/capture/modes";
import type { RecordingUnavailable } from "@/app/lib/tauri/capture";

const note = (reason: RecordingUnavailable | null, message: string | null = "Rust's line") =>
  disabledRecordingNote({ recordingUnavailable: reason, recordingUnavailableMessage: message });

describe("disabledRecordingNote", () => {
  it("shows Record normally where recording works", () => {
    expect(note(null, null)).toBeNull();
  });

  it("hides Record where the platform has no recorder", () => {
    expect(note("unsupportedPlatform")).toBeNull();
  });

  // Something the user or another build can fix must stay visible with
  // Rust's words: a Linux box missing a codec sees Record disabled with the
  // package to install, not a vanished button.
  it("shows Record disabled with Rust's line for every other reason", () => {
    const fixable: RecordingUnavailable[] = [
      "helperMissing",
      "osTooOld",
      "codecsMissing",
      "portalMissing",
      "mediaFeaturePackMissing",
    ];
    for (const reason of fixable) expect(note(reason, `why: ${reason}`)).toBe(`why: ${reason}`);
  });
});
