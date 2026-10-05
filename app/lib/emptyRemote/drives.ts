// What the empty-drive prompt shows, per drive, folded from Rust's events.
// Pure functions over an immutable Map so every transition is unit-testable
// without a Tauri runtime.
//
// Rust owns the prompt itself (count, whether this account may confirm, the
// words). The only state added here is presentation: whether the user chose
// "Keep my files" (the banner is put away until the prompt changes or its
// notification is opened), a confirmation just sent (so the banner shows it
// under way instead of offering it again), and a one-line notice after a
// refused answer.

import type { EmptyRemoteDrive } from "@/app/lib/tauri/emptyRemote";

export interface EmptyRemoteView extends EmptyRemoteDrive {
  /** "Keep my files": hidden until the next prompt event for this drive,
   *  or until its notification is opened. */
  dismissed: boolean;
  /** The confirmation was sent and accepted; the next sync applies it. */
  confirming: boolean;
  /** Why the prompt changed under the user's answer, in Rust's words. */
  notice: string | null;
}

/** Keyed by drive label. */
export type EmptyRemoteDrives = Map<string, EmptyRemoteView>;

function viewOf(drive: EmptyRemoteDrive): EmptyRemoteView {
  return { ...drive, dismissed: false, confirming: false, notice: null };
}

/**
 * `hcfs_empty_remote_held`: Rust emits it only when the prompt began, its
 * count changed, or a confirmation did not take, so it always re-raises a
 * put-away banner and drops a confirmation the new report overtook.
 */
export function applyHeld(drives: EmptyRemoteDrives, drive: EmptyRemoteDrive): EmptyRemoteDrives {
  const next = new Map(drives);
  next.set(drive.label, viewOf(drive));
  return next;
}

/** `hcfs_empty_remote_cleared`: a sync accepted a listing, or the drive
 *  stopped or was removed. */
export function applyCleared(drives: EmptyRemoteDrives, label: string): EmptyRemoteDrives {
  if (!drives.has(label)) return drives;
  const next = new Map(drives);
  next.delete(label);
  return next;
}

/**
 * Replace the map with Rust's current prompts (start, reload, or a refresh
 * after a refusal). An unchanged prompt keeps its presentation state, so a
 * refresh does not re-raise a banner the user put away.
 *
 * `eventLabels` are drives an event changed while the read was in flight:
 * the event is newer than the read for those, so they keep what the events
 * made of them.
 */
export function applyHydration(
  drives: EmptyRemoteDrives,
  current: EmptyRemoteDrive[],
  eventLabels: ReadonlySet<string> = new Set(),
): EmptyRemoteDrives {
  const next: EmptyRemoteDrives = new Map();
  for (const label of eventLabels) {
    const previous = drives.get(label);
    if (previous) next.set(label, previous);
  }
  for (const drive of current) {
    if (eventLabels.has(drive.label)) continue;
    const previous = drives.get(drive.label);
    const same =
      previous !== undefined &&
      previous.syncedCount === drive.syncedCount &&
      previous.canConfirm === drive.canConfirm;
    next.set(drive.label, same ? { ...previous, ...drive } : viewOf(drive));
  }
  return next;
}

/** Patch one drive's presentation state; no-op for a drive with no prompt. */
export function updateDrive(
  drives: EmptyRemoteDrives,
  label: string,
  patch: Partial<EmptyRemoteView>,
): EmptyRemoteDrives {
  const current = drives.get(label);
  if (!current) return drives;
  const next = new Map(drives);
  next.set(label, { ...current, ...patch });
  return next;
}
