import { hasActionableFailures } from "@/app/lib/sync/actionableFailures";
import type { SyncSnapshot } from "@/app/lib/types/syncSnapshot";

/**
 * Which of the three tray-icon artwork variants to show, or `"none"` to leave
 * the current icon untouched.
 *
 * The native tray *menu* was removed (the popover shows sync detail now); the
 * icon appearance is the only sync affordance that remains native, so this is
 * the entire observable output of the sync-snapshot watcher.
 */
export type TrayIconState = "default" | "syncing" | "completed" | "none";

/**
 * Completion latch carried across snapshots.
 *
 * The backend resets its snapshot to an empty cycle shortly after a sync
 * finishes; without latching the icon would flick off "complete" the instant
 * that empty frame arrives. `complete` marks that the last meaningful outcome
 * was a completion, and `snapshot` keeps the frame whose counts produced it so
 * later derivations (delete counts, the dedup signature) read the completed
 * state rather than the empty reset.
 */
export interface TrayLatch {
  complete: boolean;
  snapshot: SyncSnapshot | null;
}

/** The empty latch a fresh session (or a logout) starts from. */
export const EMPTY_TRAY_LATCH: TrayLatch = { complete: false, snapshot: null };

/**
 * Result of folding one snapshot into the icon state machine.
 *
 * `latch` is the NEXT latch and must be stored back unconditionally (the latch
 * advances on every snapshot). `signature` collapses snapshots that would paint
 * an identical icon so the caller can skip a redundant `setIcon` IPC — but the
 * latch update must happen BEFORE that dedup check, mirroring the original
 * inline order.
 */
export interface TrayIconDerivation {
  icon: TrayIconState;
  latch: TrayLatch;
  signature: string;
}

function countDeletes(snapshot: SyncSnapshot): number {
  return snapshot.files.filter(
    (f) => f.action === "local_delete" || f.action === "remote_delete",
  ).length;
}

/**
 * Pure fold of a sync snapshot (plus the prior latch) into the tray-icon state.
 *
 * This is the icon half of what `startSyncActivityWatcher` used to compute
 * inline alongside the now-deleted native-menu rows; extracting it keeps the
 * stateful watcher a thin shell and makes the latch/preparing/stalled-completion
 * behaviour unit-testable without a Tauri menu mock.
 *
 * Key derivations preserved verbatim from the old inline logic:
 * - `isActive` prefers `effectiveInProgress` over raw `isActive` so the
 *   stalled-completion fixup (engine leaves `isActive=true` at 100%) doesn't pin
 *   the icon on "syncing"; `isPreparing` (`widgetState === "preparing"`) surfaces
 *   the file-watcher window between PlanReady and the first populated snapshot.
 * - The latch relatches on a fresh completion and unlatches when a genuinely new
 *   session starts with files (or on the preparing flip). The two transitions are
 *   mutually exclusive (relatch needs `isCompleted ⇒ !isActive`; unlatch needs
 *   `isActive`), so order is irrelevant.
 * - `"none"` is returned for the `isActive && latched-complete` case, which the
 *   old code left the icon untouched for.
 */
export function deriveTrayIconState(
  progress: SyncSnapshot,
  prev: TrayLatch,
): TrayIconDerivation {
  const inProgressCount = progress.files.filter(
    (f) => f.status === "inProgress" || f.status === "pending",
  ).length;

  const isPreparing = progress.widgetState === "preparing";
  const isActive =
    isPreparing ||
    progress.effectiveInProgress ||
    inProgressCount > 0 ||
    (progress.totalFiles > 0 &&
      progress.completedFiles < progress.totalFiles &&
      progress.failedFiles === 0);
  const hasFailed = hasActionableFailures(progress);
  const isCompleted = !isActive && (progress.completedFiles > 0 || hasFailed);

  const recentDeleteCount = countDeletes(progress);

  // Advance the latch. Relatch on a fresh completion; unlatch when a new
  // session with files starts (or on the preparing flip — its session may have
  // no startedAt yet, so that branch skips the startedAt check).
  let complete = prev.complete;
  let snapshot = prev.snapshot;
  if (isCompleted && (!complete || progress.startedAt !== snapshot?.startedAt)) {
    complete = true;
    snapshot = progress;
  }
  if (
    isActive &&
    complete &&
    (isPreparing ||
      (progress.startedAt !== null &&
        progress.startedAt !== snapshot?.startedAt &&
        progress.totalFiles > 0))
  ) {
    complete = false;
    snapshot = null;
  }

  const isNewSessionWithFiles =
    isActive &&
    progress.startedAt !== null &&
    progress.startedAt !== snapshot?.startedAt &&
    progress.totalFiles > 0;
  const effectiveCompleted =
    isCompleted || (complete && !isPreparing && !isNewSessionWithFiles);
  const effectiveSnapshot =
    effectiveCompleted && !isCompleted && snapshot ? snapshot : progress;
  const effectiveDeleteCount =
    effectiveCompleted && !isCompleted && snapshot
      ? countDeletes(snapshot)
      : recentDeleteCount;

  const signature = `${isActive}:${effectiveCompleted}:${hasFailed}:${effectiveSnapshot.completedFiles}/${effectiveSnapshot.totalFiles}:${effectiveSnapshot.failedFiles}:${effectiveSnapshot.overallPercent}:${effectiveSnapshot.progressBytes}:del${effectiveDeleteCount}:sa${effectiveSnapshot.startedAt}`;

  let icon: TrayIconState;
  if (!isActive && !effectiveCompleted && effectiveDeleteCount === 0) {
    icon = "default";
  } else if (isActive && !complete) {
    icon = "syncing";
  } else if (effectiveCompleted && hasFailed) {
    // Failed completion uses the default (not "completed") artwork.
    icon = "default";
  } else if (effectiveCompleted) {
    icon = "completed";
  } else if (!isActive && !effectiveCompleted && effectiveDeleteCount > 0) {
    // Delete-only activity with no transfer still marks the icon complete.
    icon = "completed";
  } else {
    // isActive while latched-complete — leave the icon as-is.
    icon = "none";
  }

  return { icon, latch: { complete, snapshot }, signature };
}
