import type {
  DriveEntry,
  DriveStatus,
} from "@/app/lib/global-atoms/unpinAtoms";
import type { SyncFolder } from "@/app/lib/types/sync-folder";

/**
 * Collapse the backend's tagged `DriveStatus` union into a folder row's
 * three-state status.
 *
 * This is the ONLY place that collapse may happen — `MultiFolderSyncManager`
 * and `DriveOnboarding` both route their `driveStatusesAtom` reconciliation
 * through it, so the two surfaces cannot diverge. Their previous inline
 * mappings collapsed `error` into `"paused"`, which hid every
 * `DriveStatus.Error` (per-drive init failures AND revoked shared drives)
 * behind a Paused pill with a Resume affordance.
 */
export function rowStatusFromDriveStatus(
  status: DriveStatus
): SyncFolder["status"] {
  switch (status.kind) {
    case "active":
      return "syncing";
    case "paused":
      return "paused";
    case "error":
      return "error";
  }
}

/**
 * Fold a `driveStatusesAtom` entry into a `SyncFolder` row: status via
 * `rowStatusFromDriveStatus`, plus the error message while (and only while)
 * the drive is errored, so a recovered drive drops its stale message.
 *
 * Returns the SAME object when nothing changed, preserving the row-identity
 * guard the reconciliation effects rely on to avoid render thrash.
 */
export function applyDriveStatusToRow(
  entry: DriveEntry | undefined,
  row: SyncFolder
): SyncFolder {
  if (!entry) return row;

  const status = rowStatusFromDriveStatus(entry.status);
  const errorMessage =
    entry.status.kind === "error" ? entry.status.message : undefined;

  if (row.status === status && row.errorMessage === errorMessage) return row;
  return { ...row, status, errorMessage };
}
