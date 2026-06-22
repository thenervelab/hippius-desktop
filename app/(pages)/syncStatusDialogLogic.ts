import type { SyncSnapshot } from "../lib/types/syncSnapshot";

export interface TransferBytes {
  progress: number;
  expected: number;
}

/**
 * Pick the byte pair for the widget's live "transferred / total" readout.
 *
 * It MUST come from the same byte-granular, current-cycle counters that drive
 * the percent ring (`overallPercent` is weighted on these) and the speed/ETA
 * (which finite-difference `combinedProgressBytes`). The intent overlay is
 * deliberately NOT consulted here: it counts only whole-FILE-completed bytes
 * and is summed account-wide, so for a single in-flight file it reads 0 for the
 * entire upload while the ring and speed climb on partial bytes — the
 * "0B / 260MB at 16%" report. The intent overlay drives the file-count
 * "X of Y" line only.
 */
export function selectLiveTransferBytes(
  snapshot: Pick<
    SyncSnapshot,
    | "combinedProgressBytes"
    | "combinedBytesExpected"
    | "progressBytes"
    | "bytesExpected"
  >,
): TransferBytes | null {
  if (snapshot.combinedBytesExpected > 0) {
    return {
      progress: snapshot.combinedProgressBytes,
      expected: snapshot.combinedBytesExpected,
    };
  }
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
