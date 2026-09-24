/**
 * Gates for folder grants (share one folder of a shared drive, read-only).
 *
 * Distinct from public "Share via link" folder shares (`folderShareGating.ts`):
 * this mints a drive invite with `path_prefix`, not a `/v1/folder-shares` link.
 * Join is console-only; desktop only creates/manages/copies the invite URL.
 */

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { ServerCapabilities } from "@/app/lib/tauri/shares";
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
  /**
   * With folder roles on: labels of drives (or granted folders) somebody
   * else owns where this account is a Manager, not frozen. A Manager may
   * share a folder at or below what they manage.
   */
  manageableMemberLabels?: ReadonlySet<string>,
): boolean {
  if (!file.isFolder) return false;
  if (!folderGrantsEnabled) return false;
  if (!isMemberDriveLabel(file.label, memberDriveLabels)) return true;
  return Boolean(file.label && manageableMemberLabels?.has(file.label));
}

/**
 * Whether folder collaboration with roles is available: the staging-only lane
 * flag AND a server advertising folder grants with roles. Unknown
 * capabilities (`null`) read as off, so nothing appears until it is known.
 */
export function folderRolesAvailable(
  flag: boolean,
  caps: Pick<ServerCapabilities, "folder_grants" | "folder_grant_roles"> | null,
): boolean {
  return flag && caps?.folder_grants === true && caps?.folder_grant_roles === true;
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
