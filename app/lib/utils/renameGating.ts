import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { isCloudOnlyRow } from "@/app/lib/utils/cloudOnly";

/**
 * Single gate for whether a row's "Rename" action is enabled. Shared by the
 * files-table menu, card view, and the right-click context menu so the three
 * surfaces can't drift.
 *
 * Rename is an on-disk operation (`rename_entry` does `fs::rename` inside the
 * drive and lets the sync engine propagate it as a server-side rename), so it
 * needs the entry to actually be on this device and at rest:
 *
 * - `!isAssigned`: still mid-upload — no settled server identity to rename.
 * - `isCloudOnlyRow`: nothing on disk to rename — a cloud-only search hit,
 *   a pending download, or any row of a browsable REMOTE drive (whose
 *   FOLDER rows carry a `remote://` sentinel `source` that a bare
 *   `fileId && !source` check used to mistake for a local path).
 * - explicit non-"synced" status: pending download / uploading / failed rows
 *   are races waiting to happen. `undefined` status (plain local listings
 *   that never set one) stays renameable.
 */
export function canRenameFile(file: FormattedUserFile): boolean {
  if (!file.isAssigned) return false;
  if (isCloudOnlyRow(file)) return false;
  if (file.syncStatus !== undefined && file.syncStatus !== "synced") return false;
  return true;
}

export const RENAME_DISABLED_TOOLTIP =
  "Only items synced on this device can be renamed. Wait for sync to finish and try again.";
