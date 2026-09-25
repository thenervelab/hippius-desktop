/**
 * Gates for folder grants (share one folder of a drive).
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
 * Whether a folder row may offer "Share folder": an own drive, or one this
 * account MANAGES (a drive Manager). Never an Editor or Viewer, and never a
 * granted folder: only the owner or a full drive Manager mints folder
 * invites. `folderInvitesOffered` is {@link folderShareInviteOffered}.
 */
export function canShareFolderGrant(
  file: FormattedUserFile,
  folderInvitesOffered: boolean,
  memberDriveLabels?: ReadonlySet<string>,
  /**
   * With folder roles on: labels of drives somebody else owns where this
   * account is a Manager, not frozen.
   */
  manageableMemberLabels?: ReadonlySet<string>,
): boolean {
  if (!file.isFolder) return false;
  if (!folderInvitesOffered) return false;
  if (!isMemberDriveLabel(file.label, memberDriveLabels)) return true;
  return Boolean(file.label && manageableMemberLabels?.has(file.label));
}

/**
 * Whether "Share folder" is a live action. Inside the folder-roles flag it
 * always is: the item never waits on a capability, and a server that refuses
 * says "coming soon" instead. Without the flag, the older read-only folder
 * sharing appears only once the server advertises `folder_grants`; unknown
 * capabilities (`null`) read as off there.
 */
export function folderShareInviteOffered(
  folderRolesFlag: boolean,
  caps: Pick<ServerCapabilities, "folder_grants"> | null,
): boolean {
  return folderRolesFlag || caps?.folder_grants === true;
}

export const FOLDER_GRANT_DISABLED_TOOLTIP =
  "The connected server doesn't support sharing a folder of a drive yet.";

/**
 * Drive-relative path for a folder-grant mint. Same resolution as the
 * public folder-share mint so nested rows share the right folder.
 */
export function folderGrantPathPrefix(
  file: FormattedUserFile,
  parentRelativePath: string | null | undefined,
): string {
  return folderShareRelativePath(file, parentRelativePath).replace(/^\/+|\/+$/g, "");
}
