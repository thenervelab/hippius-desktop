// Pure count-normalization for the migration progress poller, extracted from
// useMigration so the clamp/fallback rules can be unit-tested without a live
// event stream.
//
// Two number sources cross the wire: `total` is the S3 OBJECT count (used for
// internal processing progress) and `logical_file_count` is the real FILE count
// from file_records, populated only once migration finishes. Users must see the
// logical count when available; `completed` is clamped so a lagging object
// count can never render "12 of 9".

export interface MigrationCountsInput {
  status: string;
  total: number;
  completed: number;
  logical_file_count: number | null;
}

/** Live display numbers for an in-progress cycle. */
export function getMigrationDisplayCounts(r: MigrationCountsInput): {
  displayTotal: number;
  displayCompleted: number;
} {
  const displayTotal = r.logical_file_count ?? r.total;
  return { displayTotal, displayCompleted: Math.min(r.completed, displayTotal) };
}

/** Final numbers + success flag for a terminal cycle (`is_terminal === true`). */
export function getMigrationTerminalState(r: MigrationCountsInput): {
  succeeded: boolean;
  finalCount: number;
  finalCompleted: number;
} {
  const finalCount = r.logical_file_count ?? r.total;
  return {
    // Any terminal status other than an explicit cancel counts as success —
    // INCLUDING a `"failed"` terminal status (Rust's TERMINAL_STATUSES is
    // completed/failed/cancelled). This matches the pre-extraction behavior;
    // whether a hard `"failed"` should instead surface as not-succeeded is a
    // product question tracked as a follow-up, not changed here.
    succeeded: r.status !== "cancelled",
    finalCount,
    finalCompleted: Math.min(r.completed, finalCount),
  };
}
