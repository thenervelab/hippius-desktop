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
