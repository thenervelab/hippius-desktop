// Pure projection helpers for the "Review Changes" dialog.
//
// These live outside the component because every bug the dialog shipped with
// was a state-projection bug, not a rendering one: a bulk-selection highlight
// that was hard-coded instead of derived, a resolutions map wiped by an
// object-identity effect, and a 64-char hash rendered in a filename column.
// Pulling the projections out makes each one directly testable and makes the
// component declarative over them.

import type { ConflictResolution, StagedConflict } from "@/lib/types/syncTypes";

export type ResolutionMap = Record<string, ConflictResolution>;

/**
 * Does this `path` look like a `FileId` the engine could not name?
 *
 * `SyncState::display_path` falls back to `hex::encode(file_id)` when no local
 * side-table knows a file — which the dialog then rendered in its filename
 * column, so users were asked to confirm deleting "91c60cf7a26c…" from the
 * server. Detecting the shape lets the UI say "unknown file" instead of
 * presenting a hash as if it were a name.
 *
 * Deliberately strict to avoid libelling a real file: the engine emits exactly
 * 32 lowercase-hex-encoded bytes with no separator and no extension, so a
 * genuine `cache/a1b2….pack` or an uppercase name never matches. A real file
 * literally named 64 lowercase hex chars at the drive root would false-positive;
 * that is an acceptable trade against silently showing hashes as filenames.
 */
export function isUnresolvedPathHash(path: string): boolean {
  return /^[0-9a-f]{64}$/.test(path);
}

/** A staged path, split into what the UI should actually render. */
export type DisplayPath =
  | { kind: "path"; value: string }
  | { kind: "unknown"; hash: string };

export function describeStagedPath(path: string): DisplayPath {
  return isUnresolvedPathHash(path)
    ? { kind: "unknown", hash: path }
    : { kind: "path", value: path };
}

/**
 * Carry the user's picks across a staged-changes refresh.
 *
 * The engine re-emits `hcfs_conflicts_pending` every time it re-stages while
 * review mode is armed, and each event carries a fresh `staged` object. The
 * dialog used to `setResolutions({})` on that identity change, silently
 * discarding an in-progress review. Keeping any pick whose conflict is still
 * present — and dropping the rest so a stale id can never be submitted — is
 * both safer and what the user expects.
 *
 * Returns `prev` unchanged when nothing was dropped, so callers can use the
 * result as state directly without looping on a new object identity.
 */
export function reconcileResolutions(
  prev: ResolutionMap,
  conflicts: StagedConflict[],
): ResolutionMap {
  const live = new Set(conflicts.map((c) => c.file_id));
  const kept: ResolutionMap = {};
  let dropped = false;

  for (const [fileId, resolution] of Object.entries(prev)) {
    if (live.has(fileId)) kept[fileId] = resolution;
    else dropped = true;
  }

  return dropped ? kept : prev;
}

/**
 * The resolution every conflict currently shares, or `null` when they differ
 * or any is still unset.
 *
 * This is what the "Apply to all" control binds to. Deriving it from the same
 * map the rows read is the fix for the reported bug: the old bar coloured
 * "Keep Both" from a static variant table, so the highlight never moved when
 * the user picked something else and could not be made to agree with the rows.
 * A derived value cannot disagree with them by construction.
 */
export function deriveBulkSelection(
  resolutions: ResolutionMap,
  conflicts: StagedConflict[],
): ConflictResolution | null {
  if (conflicts.length === 0) return null;

  const first = resolutions[conflicts[0].file_id];
  if (!first) return null;

  return conflicts.every((c) => resolutions[c.file_id] === first) ? first : null;
}

/** Has every conflict been given a resolution? Vacuously true with none. */
export function areAllConflictsResolved(
  resolutions: ResolutionMap,
  conflicts: StagedConflict[],
): boolean {
  return conflicts.every((c) => Boolean(resolutions[c.file_id]));
}

/**
 * Would submitting these resolutions actually change anything?
 *
 * `skip` DEFERS a conflict — the engine re-detects it next cycle and the banner
 * returns. Submitting an all-`skip` review therefore satisfies the "resolve all
 * N conflicts" gate while resolving none, which is exactly what the user in the
 * report did before concluding the button did nothing. The dialog uses this to
 * say so up front rather than letting them discover it a cycle later.
 */
export function isEntirelyDeferred(
  resolutions: ResolutionMap,
  conflicts: StagedConflict[],
): boolean {
  return (
    conflicts.length > 0 &&
    conflicts.every((c) => resolutions[c.file_id] === "skip")
  );
}

/** Apply one resolution to every conflict. */
export function applyToAll(
  conflicts: StagedConflict[],
  resolution: ConflictResolution,
): ResolutionMap {
  return Object.fromEntries(conflicts.map((c) => [c.file_id, resolution]));
}
