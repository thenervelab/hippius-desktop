import { describe, expect, it } from "vitest";
import {
  ETA_SMOOTHING_ALPHA,
  resolveSmoothedEta,
  resolveSmoothedPercent,
  selectLiveTransferBytes,
  smoothSpeed,
  SPEED_SMOOTHING_ALPHA,
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

describe("smoothSpeed", () => {
  it("seeds from the sample on the first reading (no prior smoothed value)", () => {
    // After a reset the ref is null; the readout must start at the real rate,
    // not crawl up from zero.
    expect(smoothSpeed(null, 5_000_000)).toBe(5_000_000);
    expect(smoothSpeed(0, 5_000_000)).toBe(5_000_000);
    expect(smoothSpeed(-1, 5_000_000)).toBe(5_000_000);
  });

  it("blends sample and previous by the EMA factor", () => {
    // alpha * sample + (1 - alpha) * previous.
    const a = SPEED_SMOOTHING_ALPHA;
    expect(smoothSpeed(100, 200)).toBeCloseTo(a * 200 + (1 - a) * 100);
  });

  it("damps a single spike far below the raw sample (the wild-ETA fix)", () => {
    // A 10x rate spike on one tick must move the smoothed value only a fraction
    // of the way, so the derived ETA can't lurch on transient jitter.
    const smoothed = smoothSpeed(1_000_000, 10_000_000);
    expect(smoothed).toBeGreaterThan(1_000_000);
    expect(smoothed).toBeLessThan(10_000_000);
    // With alpha 0.25 the spike contributes only a quarter of the gap.
    expect(smoothed).toBeCloseTo(1_000_000 + 0.25 * 9_000_000);
  });

  it("converges toward a steady rate when fed it repeatedly", () => {
    // A constant input must drive the smoothed value to that input — the
    // steady-state readout matches the true rate, no permanent lag.
    let speed: number | null = null;
    for (let i = 0; i < 40; i++) {
      speed = smoothSpeed(speed, 3_000_000);
    }
    expect(speed).toBeCloseTo(3_000_000, 0);
  });

  it("stays within the interval bounded by previous and sample", () => {
    // EMA is a convex combination, so the result can never overshoot either
    // endpoint regardless of the inputs.
    const lo = smoothSpeed(2_000_000, 8_000_000);
    expect(lo).toBeGreaterThanOrEqual(2_000_000);
    expect(lo).toBeLessThanOrEqual(8_000_000);
    const hi = smoothSpeed(8_000_000, 2_000_000);
    expect(hi).toBeLessThanOrEqual(8_000_000);
    expect(hi).toBeGreaterThanOrEqual(2_000_000);
  });
});

describe("resolveSmoothedEta (F-4 ETA jitter)", () => {
  it("seeds from the sample on the first reading", () => {
    expect(resolveSmoothedEta(null, 120)).toBe(120);
  });

  it("does NOT re-seed on a near-zero previous (an almost-done ETA is real)", () => {
    // Unlike smoothSpeed, a 0/near-0 previous is a legitimate value, so the EMA
    // must blend, not seed — otherwise the ETA would snap back up at the finish.
    const next = resolveSmoothedEta(0, 10, 0.3);
    expect(next).toBeCloseTo(3, 5); // 0.3*10 + 0.7*0
  });

  it("blends as a standard EMA", () => {
    expect(resolveSmoothedEta(100, 200, 0.3)).toBeCloseTo(130, 5);
  });

  it("damps the plan-growth up-jump far more than the raw ETA swings", () => {
    // Steady raw ETA, then the plan grows (a new file enters → numerator steps
    // up), then it resumes counting down. The raw stream lurches; the smoothed
    // one absorbs the step. This is the F-4 fix: frame-to-frame ETA stability.
    const raw = [100, 100, 100, 250, 245, 240, 235, 230];
    let smoothed: number | null = null;
    const smoothedStream = raw.map((r) => {
      smoothed = resolveSmoothedEta(smoothed, r, ETA_SMOOTHING_ALPHA);
      return smoothed;
    });

    const maxStep = (xs: number[]) =>
      xs.slice(1).reduce((m, x, i) => Math.max(m, Math.abs(x - xs[i])), 0);

    const rawMaxStep = maxStep(raw); // the 100→250 jump = 150
    const smoothedMaxStep = maxStep(smoothedStream as number[]);

    expect(rawMaxStep).toBe(150);
    // The smoother never lets a single frame move more than alpha*the gap.
    expect(smoothedMaxStep).toBeLessThan(rawMaxStep * ETA_SMOOTHING_ALPHA + 1);
    // And it never overshoots the raw range.
    for (const s of smoothedStream as number[]) {
      expect(s).toBeGreaterThanOrEqual(100);
      expect(s).toBeLessThanOrEqual(250);
    }
  });

  it("converges toward the raw value under a constant input", () => {
    let smoothed: number | null = 100;
    for (let i = 0; i < 40; i++) {
      smoothed = resolveSmoothedEta(smoothed, 60, ETA_SMOOTHING_ALPHA);
    }
    expect(smoothed).toBeCloseTo(60, 1);
  });
});
