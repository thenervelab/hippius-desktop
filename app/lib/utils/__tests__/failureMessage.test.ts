import { describe, it, expect } from "vitest";
import { failureMessage } from "@/app/lib/utils/failureMessage";
import type { FileFailureRecord } from "@/app/lib/types/fileFailure";

const base: FileFailureRecord = {
  label: "drive",
  relativePath: "a/b.txt",
  fileName: "b.txt",
  kind: "network",
  message: null,
  httpStatus: null,
  balanceCents: null,
  requiredCents: null,
  failureCount: 1,
  lastFailedAt: 0,
};

describe("failureMessage", () => {
  it("phrases insufficientBalance with both amounts when present", () => {
    const msg = failureMessage({
      ...base,
      kind: "insufficientBalance",
      balanceCents: 12,
      requiredCents: 100,
    });
    expect(msg).toBe("Insufficient credits — needs $1.00, you have $0.12.");
  });

  it("includes the http status for serverError", () => {
    expect(failureMessage({ ...base, kind: "serverError", httpStatus: 500 })).toBe(
      "Server error (500). Please try again."
    );
  });

  it("has a fixed line for network failures", () => {
    expect(failureMessage({ ...base, kind: "network" })).toMatch(/network error/i);
  });

  it("uses the message for `other`, with a generic fallback", () => {
    expect(failureMessage({ ...base, kind: "other", message: "boom" })).toBe("boom");
    expect(failureMessage({ ...base, kind: "other", message: "   " })).toBe(
      "Sync failed. Please try again."
    );
  });

  it("phrases a mid-upload change as self-resolving, not as a crypto fault", () => {
    // Must read identically to Rust's
    // `FileFailureKindPayload::ChangedWhileUploading::display_reason()` — the
    // drive-table badge and the sync widget describe the same failure from two
    // different data sources (persisted row vs live snapshot string).
    const msg = failureMessage({ ...base, kind: "changedWhileUploading" });
    expect(msg).toBe("File changed while uploading — will retry.");
    expect(msg.toLowerCase()).not.toContain("encryption");
  });

  it("degrades an unknown future kind to the generic line", () => {
    expect(failureMessage({ ...base, kind: "somethingNew" })).toBe(
      "Sync failed. Please try again."
    );
  });
});
