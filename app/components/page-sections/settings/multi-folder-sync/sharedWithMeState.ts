// Pure view/row routing for `SharedWithMeSection` — the sidebarSearchState
// convention. Unit-tested in `__tests__/sharedWithMeState.test.ts`.

import type {
  DriveMembershipInfo,
  MyFolderGrantInfo,
} from "@/app/lib/tauri/sharedDrives";

/** Data lifecycle of the memberships fetch. */
export type SharedWithMeData =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; memberships: DriveMembershipInfo[] }
  | { kind: "unavailable" }
  | { kind: "error" };

export type SharedWithMeView = "hidden" | "loading" | "empty" | "rows";

/**
 * What the section renders.
 *
 * Where there is nowhere to start sharing from (Settings), it stays quiet:
 * every non-rows state (flag off, still loading, empty, feature-off server,
 * a failed passive fetch) renders NOTHING rather than a headline with a
 * skeleton or an error under it.
 *
 * On the Drive page (`alwaysShow`), the section is how people find shared
 * drives, so it is there whenever the flag is on: skeleton rows until both
 * listings have answered, then the rows, or the empty state that offers
 * "Share a drive". A feature-off server still hides it (the quiet degrade
 * the feature-off rule requires). A failed fetch shows the empty state:
 * sharing a drive is still possible, and the rows come back on the next
 * visit.
 */
export function getSharedWithMeView(
  enabled: boolean,
  data: SharedWithMeData,
  /** Folders shared with this account (folder roles). Rows of their own. */
  folderGrantCount = 0,
  options: {
    /** Show the section even with nothing shared (the Drive page). */
    alwaysShow?: boolean;
    /** Whether the folder-grant listing has answered. */
    grantsSettled?: boolean;
  } = {},
): SharedWithMeView {
  if (!enabled) return "hidden";
  const { alwaysShow = false, grantsSettled = true } = options;
  const hasMemberships =
    data.kind === "ready" && data.memberships.length > 0;
  if (hasMemberships || folderGrantCount > 0) return "rows";
  if (!alwaysShow) return "hidden";
  switch (data.kind) {
    case "unavailable":
      return "hidden";
    case "idle":
    case "loading":
      return "loading";
    case "ready":
    case "error":
      return grantsSettled ? "empty" : "loading";
  }
}

export type MembershipRowAction =
  | { kind: "synced"; localLabel: string }
  | { kind: "sync-locally" };

/**
 * How a membership row's action side renders. `synced` requires BOTH join
 * fields from Rust — a `syncedLocally` without a label (which the backend
 * never produces; `localLabel` is null exactly when unsynced) degrades to
 * offering "Sync locally", whose backend is idempotent per wire identity
 * and would simply repair/name the existing slot.
 */
export function getMembershipRowAction(
  membership: Pick<DriveMembershipInfo, "syncedLocally" | "localLabel">,
): MembershipRowAction {
  if (membership.syncedLocally && membership.localLabel) {
    return { kind: "synced", localLabel: membership.localLabel };
  }
  return { kind: "sync-locally" };
}

/** How one shared FOLDER reads in the list. */
export interface FolderGrantRowView {
  /** Stable key: owner, drive and folder (a drive can grant several). */
  key: string;
  /** The folder's own name: the last segment of its path. */
  folderName: string;
  /** The full folder path, for the hover. */
  path: string;
}

export function folderGrantRowView(
  grant: Pick<MyFolderGrantInfo, "ownerSs58" | "folderHash" | "pathPrefix">,
): FolderGrantRowView {
  const path = grant.pathPrefix.replace(/^\/+|\/+$/g, "");
  const segments = path.split("/").filter(Boolean);
  return {
    key: `${grant.ownerSs58}:${grant.folderHash}:${path}`,
    folderName: segments[segments.length - 1] ?? path,
    path,
  };
}

/**
 * The hover on a shared folder's member count, in the console's words
 * (`MembersCell`). The count is everyone with access to the folder, this
 * account included, and leaves the drive's owner out, so the owner is named
 * apart: "only you have access" would be false on every folder. "Have
 * access", not "can open": a frozen owner's drive admits nobody until it
 * lifts, and the row says frozen on its own.
 */
export function folderGrantMemberCountTitle(memberCount: number): string {
  return memberCount === 1
    ? "Only you and the drive's owner have access to this folder"
    : `${memberCount} people have access to this folder, you included, plus the drive's owner`;
}
