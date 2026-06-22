import { describe, expect, it } from "vitest";
import {
  resolveSmoothedPercent,
  selectLiveTransferBytes,
} from "../syncStatusDialogLogic";
import {
  makeFileProgress,
  makeSnapshot,
} from "@/app/lib/test-utils/syncSnapshotFactory";

describe("selectLiveTransferBytes", () => {
  it("reports the real file-size total, NOT the doubled encrypt+transfer total", () => {
    // The user-reported "doubled total" bug. hcfs-client's combined counters
    // treat a transfer as two phases of work (encrypt + upload), so a single
    // 162 MB upload has combinedBytesExpected = 324 MB. The widget's
    // "transferred / total" line must show the real 162 MB — the same
    // single-count total the ring's overall_percent and the per-file row use.
    const snapshot = makeSnapshot([
      makeFileProgress("big.dmg", {
        status: "inProgress",
        progressPercent: 50,
        totalBytes: 162_000_000,
        bytesEncrypted: 162_000_000,
        bytesTransferred: 81_000_000,
      }),
    ]);

    // Guard: the factory now faithfully reproduces the doubling, so the trap is
    // present for the selector to step around.
    expect(snapshot.combinedBytesExpected).toBe(324_000_000);

    expect(selectLiveTransferBytes(snapshot)).toEqual({
      progress: 81_000_000,
      expected: 162_000_000,
    });
  });

  it("keeps the transferred fraction equal to the ring's overall_percent source", () => {
    // overall_percent is weighted on progressBytes / bytesExpected, so the
    // header A/B must use the same pair or the ring and the byte line disagree
    // (e.g. ring 50% beside a line that implies 75% of a doubled total).
    const snapshot = makeSnapshot([
      makeFileProgress("big.dmg", {
        status: "inProgress",
        progressPercent: 50,
        totalBytes: 162_000_000,
        bytesEncrypted: 162_000_000,
        bytesTransferred: 81_000_000,
      }),
    ]);

    const bytes = selectLiveTransferBytes(snapshot)!;
    expect(Math.round((bytes.progress / bytes.expected) * 100)).toBe(
      snapshot.overallPercent,
    );
  });

  it("NEVER reports 0 transferred while bytes are in flight (the 0B/16% bug)", () => {
    // A single 260 MB file 16% in. The transferred figure must track the
    // byte-granular counter (~41 MB), never the intent overlay's 0.
    const snapshot = makeSnapshot([
      makeFileProgress("Air.dmg", {
        status: "inProgress",
        progressPercent: 16,
        totalBytes: 260_000_000,
        bytesTransferred: 41_600_000,
      }),
    ]);

    const bytes = selectLiveTransferBytes(snapshot);
    expect(bytes).not.toBeNull();
    expect(bytes!.progress).toBe(41_600_000);
    expect(bytes!.expected).toBe(260_000_000);
  });

  it("returns null when no byte total is known yet", () => {
    expect(
      selectLiveTransferBytes({ progressBytes: 0, bytesExpected: 0 }),
    ).toBeNull();
  });
});

describe("resolveSmoothedPercent", () => {
  it("clamps upward within a stable plan (suppresses backward jitter)", () => {
    expect(resolveSmoothedPercent(40, 38, false)).toBe(40);
    expect(resolveSmoothedPercent(40, 42, false)).toBe(42);
  });

  it("re-seeds (allows a drop) when the plan legitimately changes", () => {
    // Retry/re-plan/partial-failure lowered the real percent — the ring must
    // follow it down, not stay pinned at the old high-water mark.
    expect(resolveSmoothedPercent(90, 20, true)).toBe(20);
  });

  it("snaps to 100 once raw reaches 100", () => {
    expect(resolveSmoothedPercent(80, 100, false)).toBe(100);
    expect(resolveSmoothedPercent(80, 130, false)).toBe(100);
  });

  it("passes null through and seeds from the first non-null", () => {
    expect(resolveSmoothedPercent(null, null, false)).toBeNull();
    expect(resolveSmoothedPercent(null, 30, false)).toBe(30);
    expect(resolveSmoothedPercent(50, null, false)).toBeNull();
  });
});
