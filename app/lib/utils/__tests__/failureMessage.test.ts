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

  it("gives undecryptable its own copy and never promises a retry", () => {
    // The one kind that does NOT resolve itself: hcfs quarantines the file
    // after two failed attempts on the same revision and stops fetching it.
    // Telling the user to wait would be telling them to wait forever.
    const msg = failureMessage({ ...base, kind: "undecryptable" });
    expect(msg).toBe(
      "Can't be decrypted on this device — needs to be re-uploaded or removed."
    );
    expect(msg.toLowerCase()).not.toContain("retry");
    expect(msg.toLowerCase()).not.toContain("try again");
  });

  it("does not let an undecryptable row fall through to the generic line", () => {
    // Before the hcfs bump this variant did not exist, so it landed in the
    // `other`/default branch. `not.toBe` alone would also pass if the case
    // were deleted and `message` happened to be set, so the row carries the
    // generic text explicitly: only a real `undecryptable` case beats it.
    const msg = failureMessage({
      ...base,
      kind: "undecryptable",
      message: "Sync failed. Please try again.",
    });
    expect(msg).not.toBe("Sync failed. Please try again.");
  });

  it("includes the http status for serverError", () => {
    expect(failureMessage({ ...base, kind: "serverError", httpStatus: 500 })).toBe(
      "Server error (500). Please try again."
    );
  });

  it("phrases a 402 serverError as storage full, not try again", () => {
    // QuotaDenied / entitlement 402 — not typed insufficientBalance (credits).
    // Must read identically to Rust's QUOTA_DENIED_DISPLAY_REASON.
    const msg = failureMessage({ ...base, kind: "serverError", httpStatus: 402 });
    expect(msg).toBe("Storage full. Upgrade your plan or free up space.");
    expect(msg.toLowerCase()).not.toContain("try again");
    expect(msg).not.toContain("402");
  });

  it("phrases a session-limit 429 as self-resolving, not as too many devices", () => {
    const msg = failureMessage({ ...base, kind: "serverError", httpStatus: 429 });
    expect(msg).toBe("Too many uploads in progress — will retry.");
    expect(msg.toLowerCase()).not.toContain("device");
  });

  it("rewrites a persisted bare session-limit Other row to the retry copy", () => {
    const msg = failureMessage({
      ...base,
      kind: "other",
      message: "Too many active upload sessions",
    });
    expect(msg).toBe("Too many uploads in progress — will retry.");
  });

  it("phrases a network failure as self-resolving, not as the user's connection", () => {
    // Must read identically to Rust's
    // `FileFailureKindPayload::Network::display_reason()`.
    const msg = failureMessage({ ...base, kind: "network" });
    expect(msg).toBe("Couldn't reach the server — will retry.");
    expect(msg.toLowerCase()).not.toContain("connection");
    expect(msg.toLowerCase()).not.toContain("http");
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

  it("phrases a vanished local file as self-resolving, not as a connection fault", () => {
    // Must read identically to Rust's
    // `FileFailureKindPayload::Gone::display_reason()`.
    const msg = failureMessage({ ...base, kind: "gone" });
    expect(msg).toBe("File disappeared before upload — will retry.");
    expect(msg.toLowerCase()).not.toContain("connection");
  });

  it("degrades an unknown future kind to the generic line", () => {
    expect(failureMessage({ ...base, kind: "somethingNew" })).toBe(
      "Sync failed. Please try again."
    );
  });
});
