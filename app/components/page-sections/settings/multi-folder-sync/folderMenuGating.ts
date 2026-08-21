// Pure own-vs-member gating for the folder row menus (the 3-dot
// TableActionMenu and the right-click FolderCardContextMenu in
// LocalFoldersSection). One resolver feeds both menus so they cannot
// diverge — the sidebar-nav `filterNavSections` / `settingsNavGating`
// convention. Unit-tested in `__tests__/folderMenuGating.test.ts`.

import type { SyncFolder } from "@/app/lib/types/sync-folder";

export interface FolderMenuFlags {
  /** `SHARED_DRIVES_ENABLED` — passed in so the resolver stays pure. */
  sharedDrivesEnabled: boolean;
}

/**
 * Which gated items a folder row's menus show, and how the remove item
 * reads. The ungated items (Browse / Pause-Resume / Open in Finder) are
 * not represented here — they render for every row unconditionally.
 */
export interface FolderMenuPlan {
  /** "Share drive…" — own drives only, and only while the flag is on. */
  showShareDrive: boolean;
  /**
   * Owner-only items a member has no authority over: "Excluded from Sync"
   * (exclusions are the owner's selective-sync store) and "Delete from
   * Server" (a member cannot unregister the owner's folder — the backend
   * would key the delete by the wrong identity).
   */
  showExclusions: boolean;
  showDeleteFromServer: boolean;
  /**
   * The remove item's wording: "Leave shared drive" for a member row (it
   * routes through `leave_shared_drive`, which also does the local
   * removal), "Remove from Sync" otherwise.
   */
  removeItemTitle: "Remove from Sync" | "Leave shared drive";
  /** True when the remove item must route through `leave_shared_drive`. */
  removeIsLeave: boolean;
}

/** A row is a member drive iff Rust threaded an owner onto it. */
export function isMemberDrive(folder: Pick<SyncFolder, "ownerSs58">): boolean {
  return typeof folder.ownerSs58 === "string" && folder.ownerSs58.length > 0;
}

/**
 * Resolve the gated menu items for one folder row.
 *
 * Flag OFF is the full fallback: every row — member rows included, should
 * one exist from an earlier flag-on build — gets the plain own-drive menu,
 * so no shared-drive surface (item, wording, or routing) is reachable
 * while the feature is dark.
 */
export function resolveFolderMenuPlan(
  folder: Pick<SyncFolder, "ownerSs58">,
  flags: FolderMenuFlags,
): FolderMenuPlan {
  const member = flags.sharedDrivesEnabled && isMemberDrive(folder);

  return {
    showShareDrive: flags.sharedDrivesEnabled && !member,
    showExclusions: !member,
    showDeleteFromServer: !member,
    removeItemTitle: member ? "Leave shared drive" : "Remove from Sync",
    removeIsLeave: member,
  };
}
