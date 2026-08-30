import { describe, it, expect } from "vitest";
import { isSharedDrivesUnavailable } from "@/lib/tauri/sharedDrives";

describe("isSharedDrivesUnavailable", () => {
  it("matches the feature-off server refusal by subkind, not message", () => {
    expect(
      isSharedDrivesUnavailable({
        kind: "NotReady",
        subkind: "SHARED_DRIVES_UNAVAILABLE",
        message: "reworded copy",
      })
    ).toBe(true);
  });

  it("does not treat other NotReady kinds as feature-off", () => {
    expect(
      isSharedDrivesUnavailable({
        kind: "NotReady",
        subkind: "INSUFFICIENT_CREDITS",
        message: "Shared drives unavailable",
      })
    ).toBe(false);
  });

  it("returns false for non-errors", () => {
    expect(isSharedDrivesUnavailable(null)).toBe(false);
    expect(isSharedDrivesUnavailable({ kind: "Validation" })).toBe(false);
  });
});
