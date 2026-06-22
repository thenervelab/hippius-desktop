import { describe, expect, it } from "vitest";
import {
  resolveSmoothedPercent,
  selectLiveTransferBytes,
} from "../syncStatusDialogLogic";

describe("selectLiveTransferBytes", () => {
  it("uses the combined byte-granular counters when available", () => {
    expect(
      selectLiveTransferBytes({
        combinedProgressBytes: 41_600_000,
        combinedBytesExpected: 260_000_000,
        progressBytes: 0,
        bytesExpected: 260_000_000,
      }),
    ).toEqual({ progress: 41_600_000, expected: 260_000_000 });
  });

  it("NEVER reports 0 transferred while bytes are in flight (the 0B/16% bug)", () => {
    // The screenshot scenario: a single 260MB file 16% in. The intent overlay
    // would say 0 completed bytes; the byte-granular counter must say ~41MB.
    const bytes = selectLiveTransferBytes({
      combinedProgressBytes: 41_600_000,
      combinedBytesExpected: 260_000_000,
      progressBytes: 41_600_000,
      bytesExpected: 260_000_000,
    });
    expect(bytes).not.toBeNull();
    expect(bytes!.progress).toBeGreaterThan(0);
  });

  it("falls back to the per-cycle pair when combined is unavailable", () => {
    expect(
      selectLiveTransferBytes({
        combinedProgressBytes: 0,
        combinedBytesExpected: 0,
        progressBytes: 10,
        bytesExpected: 100,
      }),
    ).toEqual({ progress: 10, expected: 100 });
  });

  it("returns null when no byte total is known yet", () => {
    expect(
      selectLiveTransferBytes({
        combinedProgressBytes: 0,
        combinedBytesExpected: 0,
        progressBytes: 0,
        bytesExpected: 0,
      }),
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
