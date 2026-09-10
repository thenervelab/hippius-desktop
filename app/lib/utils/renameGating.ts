import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { isCloudOnlyRow } from "@/app/lib/utils/cloudOnly";
import { remoteLabelFromSource } from "@/app/lib/hooks/use-nested-folder-listing";

/**
 * The drive a row was browsed from when it is not synced here, or `null`.
 *
 * Folder rows carry it in the `remote://` sentinel source and file rows in
 * `remoteDriveLabel`; this is the one place that difference is absorbed,
 * so the gate and the rename itself cannot disagree about which rows are
 * renameable.
 */
export function remoteDriveLabel(file: FormattedUserFile): string | null {
  return file.remoteDriveLabel ?? remoteLabelFromSource(file.source);
}

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
 * - `isCloudOnlyRow`: nothing on disk to rename. A row of a browsable
 *   REMOTE drive is the exception — it renames on the SERVER
 *   (`rename_remote_file`), and `remoteDriveLabel` names the drive to
 *   rename in. A cloud-only search hit or a pending download has no such
 *   context and stays disabled.
 * - explicit non-"synced" status: pending download / uploading / failed rows
 *   are races waiting to happen. `undefined` status (plain local listings
 *   that never set one) stays renameable.
 */
export function canRenameFile(file: FormattedUserFile): boolean {
  if (!file.isAssigned) return false;
  if (file.syncStatus !== undefined && file.syncStatus !== "synced") return false;
  if (isCloudOnlyRow(file)) {
    // A row inside a REMOTE drive we are browsing knows which drive it
    // came from, which is everything the server-side rename needs — so it
    // is renameable even with nothing on disk.
    //
    // Read `remoteDriveLabel`, NOT the `remote://` source: that sentinel
    // is only ever set on FOLDER rows, so keying on it offered rename on
    // a remote folder while every file inside it stayed disabled.
    //
    // The other two cloud-only shapes stay disabled: a search hit from
    // another drive and a pending download both lack the folder context,
    // and renaming the wrong drive's file is worse than not offering it.
    return remoteDriveLabel(file) !== null;
  }
  return true;
}

export const RENAME_DISABLED_TOOLTIP =
  "Only items synced on this device can be renamed. Wait for sync to finish and try again.";
