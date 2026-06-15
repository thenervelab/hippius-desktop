import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

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
 * - `fileId && !source`: a cloud-only row (search/recent-uploads hit with no
 *   local path) — there is nothing on disk to rename.
 * - explicit non-"synced" status: pending download / uploading / failed rows
 *   are races waiting to happen. `undefined` status (plain local listings
 *   that never set one) stays renameable.
 */
export function canRenameFile(file: FormattedUserFile): boolean {
  if (!file.isAssigned) return false;
  if (file.fileId && !file.source) return false;
  if (file.syncStatus !== undefined && file.syncStatus !== "synced") return false;
  return true;
}

export const RENAME_DISABLED_TOOLTIP =
  "Only items synced on this device can be renamed. Wait for sync to finish and try again.";
