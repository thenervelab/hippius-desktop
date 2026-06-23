import type { SyncSnapshot } from "../lib/types/syncSnapshot";

export interface TransferBytes {
  progress: number;
  expected: number;
}

/**
 * Pick the byte pair for the widget's live "transferred / total" readout.
 *
 * Uses the single-count `progressBytes` / `bytesExpected` pair — the sum of
 * each file's real size — for two reasons:
 *   1. It is the SAME pair the ring's `overallPercent` is weighted on
 *      (hcfs-client `build_snapshot`: `overall_percent = total_progress_bytes
 *      / total_bytes_expected`), so the "A / B" fraction can never contradict
 *      the percent the ring shows.
 *   2. It is the real file size the user expects as the total.
 *
 * It deliberately does NOT use the `combined*` pair: hcfs-client counts a
 * transfer as two phases of work (`total_bytes * 2` — encrypt then upload), so
 * a single 162 MB upload has `combinedBytesExpected = 324 MB`. Displaying that
 * is the "doubled total" bug. (`combined*` legitimately drives the speed/ETA
 * finite-difference, where double-counting cancels — but not this readout.)
 * The intent overlay is also not consulted here; it drives the "X of Y" file
 * count only (it reads 0 transferred bytes mid-file — the old "0B / 260MB"
 * report).
 */
export function selectLiveTransferBytes(
  snapshot: Pick<SyncSnapshot, "progressBytes" | "bytesExpected">,
): TransferBytes | null {
  if (snapshot.bytesExpected > 0) {
    return { progress: snapshot.progressBytes, expected: snapshot.bytesExpected };
  }
  return null;
}

/**
 * Reduce the smoothed overall percent for the ring.
 *
 * Smoothing keeps the ring from jittering backwards on tiny byte-accounting
 * noise WITHIN a stable plan, but it must re-seed (not clamp) when the plan
 * legitimately changes — a new session, more files queued, a partial failure,
 * or a re-plan/retry that genuinely lowers the percent. Without the re-seed the
 * monotonic max pins the ring at a stale high-water mark for the rest of the
 * session while the byte counters show less (the "stuck high" bug).
 */
export function resolveSmoothedPercent(
  previous: number | null,
  raw: number | null,
  reseed: boolean,
): number | null {
  if (reseed) return raw;
  if (raw === null) return null;
  if (previous === null) return raw;
  if (raw >= 100) return 100;
  return Math.max(previous, raw);
}

/**
 * EMA smoothing factor for the transfer speed (and therefore the ETA).
 *
 * Snapshots arrive up to ~4x/sec and the raw windowed rate swings hard across
 * file handoffs: a file's encrypt phase fills `combinedProgressBytes` at local
 * disk speed, its upload phase fills them at network speed, so the 10-sample
 * window's rate jumps as its boundary crosses that seam. 0.25 ≈ a 3–4 sample
 * time constant — responsive enough to track a real slowdown within ~1s, damped
 * enough that the derived "time remaining" stops bouncing on longer queues.
 */
export const SPEED_SMOOTHING_ALPHA = 0.25;

/**
 * Fold a freshly-measured byte/sec rate into the running smoothed speed.
 *
 * Standard exponential moving average: `alpha * sample + (1 - alpha) * previous`.
 * Seeds directly from the sample whenever `previous` is null or non-positive
 * (first usable reading, or just after a reset) so the readout starts at the
 * real rate instead of crawling up from zero. Both the "X/s" label and the ETA
 * (`remaining / speed`) are derived from this value, so damping it here damps
 * both — fixing the wildly-fluctuating time-remaining on longer queues.
 */
export function smoothSpeed(
  previous: number | null,
  sample: number,
  alpha: number = SPEED_SMOOTHING_ALPHA,
): number {
  // `previous <= 0` only ever means "seed/reset": the caller never feeds a
  // non-positive sample (it guards on processedBytes > 0), so a real reading
  // can't drive the smoothed value to 0 — re-seeding here can't fire mid-transfer.
  if (previous === null || previous <= 0) return sample;
  return alpha * sample + (1 - alpha) * previous;
}
