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

/**
 * Tooltip for a member row's "Leave shared drive" item on a surface that
 * did not wire `onLeaveDrive`. The item renders DISABLED rather than
 * falling back to the plain remove handler — a plain Remove tears down
 * only this device's sync and strands the live server-side membership,
 * which is exactly what the member gating exists to prevent.
 */
export const LEAVE_UNAVAILABLE_TOOLTIP =
  "Leaving a shared drive isn't available from this view. Use Settings → Sync & Storage.";

/** A row is a member drive iff Rust threaded an owner onto it. */
export function isMemberDrive(folder: Pick<SyncFolder, "ownerSs58">): boolean {
  return typeof folder.ownerSs58 === "string" && folder.ownerSs58.length > 0;
}

/**
 * Resolve the gated menu items for one folder row.
 *
 * Member-ness is DATA on the row (`ownerSs58`, threaded from Rust), not
 * feature state, so everything that exists to protect a member row keys on
 * `isMemberDrive(folder)` ALONE — deliberately independent of the flag.
 * With the flag rolled back post-release, an existing member row must
 * never regain "Delete from Server" (the backend would key the delete by
 * the wrong identity) or a plain "Remove from Sync" that strands a live
 * server-side membership; `leave_shared_drive` works regardless of the UI
 * flag and both parent surfaces wire `onLeaveDrive` unconditionally.
 *
 * The flag gates only the OPT-IN surface: "Share drive…" (and, in
 * LocalFoldersSection, the cosmetic owner badge) stays hidden until the
 * feature ships, since minting invites against a feature-off server is a
 * dead control.
 */
export function resolveFolderMenuPlan(
  folder: Pick<SyncFolder, "ownerSs58">,
  flags: FolderMenuFlags,
): FolderMenuPlan {
  const member = isMemberDrive(folder);

  return {
    showShareDrive: flags.sharedDrivesEnabled && !member,
    showExclusions: !member,
    showDeleteFromServer: !member,
    removeItemTitle: member ? "Leave shared drive" : "Remove from Sync",
    removeIsLeave: member,
  };
}
