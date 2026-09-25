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

export type SharedWithMeView = "hidden" | "rows";

/**
 * Whether the section renders at all. Deliberately binary: most accounts
 * have zero memberships, so every non-rows state — flag off, still
 * loading, empty, feature-off server, or a failed passive fetch — renders
 * NOTHING rather than a headline with a skeleton or an error under it.
 * A section that appears only when there is something to show is the
 * quiet degrade the feature-off rule requires, and it costs a user with
 * memberships at most one frame of absence while the list loads.
 */
export function getSharedWithMeView(
  enabled: boolean,
  data: SharedWithMeData,
  /** Folders shared with this account (folder roles). Rows of their own. */
  folderGrantCount = 0,
): SharedWithMeView {
  if (!enabled) return "hidden";
  if (folderGrantCount > 0) return "rows";
  switch (data.kind) {
    case "idle":
    case "loading":
    case "unavailable":
    case "error":
      return "hidden";
    case "ready":
      return data.memberships.length === 0 ? "hidden" : "rows";
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
  /** The drive it lives in, as its owner named it. */
  driveName: string;
  /** The full folder path, for the hover. */
  path: string;
}

export function folderGrantRowView(
  grant: Pick<MyFolderGrantInfo, "ownerSs58" | "folderHash" | "pathPrefix" | "displayLabel">,
): FolderGrantRowView {
  const path = grant.pathPrefix.replace(/^\/+|\/+$/g, "");
  const segments = path.split("/").filter(Boolean);
  return {
    key: `${grant.ownerSs58}:${grant.folderHash}:${path}`,
    folderName: segments[segments.length - 1] ?? path,
    driveName: grant.displayLabel,
    path,
  };
}
