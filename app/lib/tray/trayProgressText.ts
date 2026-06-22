import type { SyncSnapshot } from "@/app/lib/types/syncSnapshot";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { selectLiveTransferBytes } from "@/app/(pages)/syncStatusDialogLogic";

/**
 * The two text rows the tray menu shows under its sync header:
 * `progressText` (the "X of Y files synced" / "N files failed" / "…deleted"
 * line) and `sizeText` (the "transferred / total" byte line, or null when no
 * byte total is known).
 */
export interface TrayProgressText {
  progressText: string;
  sizeText: string | null;
}

/**
 * Inputs mirror the state `useTraySync` already derives for the tray icon.
 * Two snapshots are passed because the live (in-progress) branch reads the
 * current `progress`, while the completed/failed branches read the
 * `effectiveSnapshot` (which may be the latched copy kept visible after the
 * backend resets to an empty cycle).
 */
export interface TrayProgressInput {
  /** The current live snapshot (drives the in-progress branch). */
  progress: SyncSnapshot;
  /** The latched-or-live snapshot the completed/failed branches read. */
  effectiveSnapshot: SyncSnapshot;
  isActive: boolean;
  latchedComplete: boolean;
  effectiveCompleted: boolean;
}

/**
 * Build the tray's progress + size text rows. Precondition: called only when
 * `isActive || effectiveCompleted` (the caller guards on that; otherwise there
 * is no sync session to describe).
 *
 * The byte line uses {@link selectLiveTransferBytes} — the single-count pair
 * the ring is weighted on, never the doubled encrypt+transfer combined total —
 * so the tray and the sidebar widget can never show different totals.
 */
export function getTrayProgressText(input: TrayProgressInput): TrayProgressText {
  const { progress, effectiveSnapshot, isActive, latchedComplete } = input;

  let progressText: string;
  let sizeText: string | null = null;

  if (isActive && !latchedComplete) {
    // In-progress: a brand-new cycle that has moved no bytes/files yet reads
    // "pending"; otherwise count synced files against the total.
    if (
      progress.totalFiles > 0 &&
      progress.overallPercent === 0 &&
      progress.completedFiles === 0 &&
      progress.progressBytes === 0
    ) {
      progressText = `${progress.totalFiles} ${progress.totalFiles === 1 ? "file" : "files"} pending`;
    } else {
      progressText =
        progress.totalFiles > 0
          ? `${progress.completedFiles} of ${progress.totalFiles} ${progress.totalFiles === 1 ? "file" : "files"} synced`
          : "Preparing files…";
    }
    const liveBytes = selectLiveTransferBytes(progress);
    if (liveBytes) {
      sizeText = `${formatBytes(liveBytes.progress)} / ${formatBytes(liveBytes.expected)}`;
    }
  } else if (input.effectiveCompleted && effectiveSnapshot.failedFiles > 0) {
    // Settled with failures: show the failure count and final byte totals.
    const totalFiles =
      effectiveSnapshot.completedFiles + effectiveSnapshot.failedFiles;
    progressText = `${effectiveSnapshot.failedFiles} of ${totalFiles} ${totalFiles === 1 ? "file" : "files"} failed`;
    if (effectiveSnapshot.bytesExpected > 0) {
      sizeText = `${formatBytes(effectiveSnapshot.progressBytes)} / ${formatBytes(effectiveSnapshot.bytesExpected)}`;
    }
  } else {
    // Settled successfully: distinguish synced / deleted / mixed so a
    // delete-only cycle doesn't read "0 files synced".
    const syncedFiles = effectiveSnapshot.completedFiles;
    const deletedInSession = effectiveSnapshot.files.filter(
      (f) =>
        (f.action === "local_delete" || f.action === "remote_delete") &&
        f.status === "completed",
    ).length;
    const nonDeleteSynced = syncedFiles - deletedInSession;

    if (deletedInSession > 0 && nonDeleteSynced <= 0) {
      progressText = `${deletedInSession} ${deletedInSession === 1 ? "file" : "files"} deleted`;
    } else if (deletedInSession > 0 && nonDeleteSynced > 0) {
      progressText = `${nonDeleteSynced} synced · ${deletedInSession} deleted`;
    } else {
      const totalFiles =
        effectiveSnapshot.completedFiles + effectiveSnapshot.failedFiles;
      progressText = `${effectiveSnapshot.completedFiles} of ${totalFiles} ${totalFiles === 1 ? "file" : "files"} synced`;
    }
    if (effectiveSnapshot.bytesExpected > 0) {
      sizeText = formatBytes(effectiveSnapshot.bytesExpected);
    }
  }

  return { progressText, sizeText };
}
