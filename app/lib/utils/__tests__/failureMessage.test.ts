import { describe, it, expect } from "vitest";
import {
  failedRowAction,
  failureMessage,
  isRetryableFailedFile,
  isRetryableFailure,
  UNDECRYPTABLE_MESSAGE,
} from "@/app/lib/utils/failureMessage";
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

  it("shows hcfs's own reason for a refused file, which names it", () => {
    // Rust persists hcfs's refusal message as the row's `message`; it names
    // the file and says what to do, so it is the copy.
    const reason =
      "Not synced: Photos/Beach.JPG names the same file on this filesystem as another file " +
      "(they differ only in letter case or Unicode normalization); rename one of them";
    expect(failureMessage({ ...base, kind: "refused", message: reason })).toBe(reason);
  });

  it("gives a refused row without a reason non-retry copy, not the generic line", () => {
    const msg = failureMessage({ ...base, kind: "refused", message: "  " });
    expect(msg).toBe("Not synced. This file needs your attention before it can sync.");
    expect(msg.toLowerCase()).not.toContain("retry");
    expect(msg.toLowerCase()).not.toContain("try again");
  });

  it("degrades an unknown future kind to the generic line", () => {
    expect(failureMessage({ ...base, kind: "somethingNew" })).toBe(
      "Sync failed. Please try again."
    );
  });
});

describe("isRetryableFailure", () => {
  it("offers no retry for a refusal or an undecryptable file", () => {
    // hcfs reports a refusal once per revision: a retry clears the row and
    // the next cycle refuses the file again in silence.
    expect(isRetryableFailure("refused")).toBe(false);
    expect(isRetryableFailure("undecryptable")).toBe(false);
  });

  it("offers retry for every kind a retry can fix", () => {
    for (const kind of ["network", "serverError", "insufficientBalance", "other"]) {
      expect(isRetryableFailure(kind)).toBe(true);
    }
  });
});

describe("failedRowAction", () => {
  it("offers Dismiss, not Retry, for a refusal", () => {
    expect(failedRowAction({ ...base, kind: "refused" })).toBe("dismiss");
  });

  it("offers nothing for an undecryptable file", () => {
    expect(failedRowAction({ ...base, kind: "undecryptable" })).toBeNull();
  });

  it("offers Retry for a retryable kind, and for a live failure with no saved row", () => {
    expect(failedRowAction({ ...base, kind: "network" })).toBe("retry");
    expect(failedRowAction(null)).toBe("retry");
  });
});

describe("isRetryableFailedFile", () => {
  it("decides by kind, so a refusal's own text is never read as retryable", () => {
    const refusal = "Not synced: could not be read (Permission denied)";
    expect(isRetryableFailedFile({ kind: "refused", error: refusal })).toBe(false);
    expect(isRetryableFailedFile({ kind: "network", error: UNDECRYPTABLE_MESSAGE })).toBe(true);
  });

  it("falls back to the authored undecryptable copy when no kind is known", () => {
    expect(isRetryableFailedFile({ error: UNDECRYPTABLE_MESSAGE })).toBe(false);
    expect(isRetryableFailedFile({ kind: null, error: "Server error (500)." })).toBe(true);
  });
});
