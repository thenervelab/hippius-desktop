/**
 * Gates for folder grants (share one folder of a shared drive, read-only).
 *
 * Distinct from public "Share via link" folder shares (`folderShareGating.ts`):
 * this mints a drive invite with `path_prefix`, not a `/v1/folder-shares` link.
 * Join is console-only; desktop only creates/manages/copies the invite URL.
 */

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  isMemberDriveLabel,
  folderShareRelativePath,
} from "@/app/lib/utils/folderShareGating";

/**
 * Whether a folder row may offer "Share folder". Requires the server
 * capability and an own (or managed) drive — same visibility rule as
 * public folder shares for member drives.
 */
export function canShareFolderGrant(
  file: FormattedUserFile,
  folderGrantsEnabled: boolean,
  memberDriveLabels?: ReadonlySet<string>,
): boolean {
  if (!file.isFolder) return false;
  if (!folderGrantsEnabled) return false;
  return !isMemberDriveLabel(file.label, memberDriveLabels);
}

export const FOLDER_GRANT_DISABLED_TOOLTIP =
  "The connected server doesn't support sharing a folder of a drive yet.";

/**
 * Drive-relative path for a folder-grant mint. Same resolution as the
 * public folder-share mint so nested rows share the right folder.
 */
export function folderGrantPathPrefix(
  file: FormattedUserFile,
  parentRelativePath: string,
): string {
  return folderShareRelativePath(file, parentRelativePath).replace(/^\/+|\/+$/g, "");
}
