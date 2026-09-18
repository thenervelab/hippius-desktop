// Pure own-vs-member gating for the folder row menus (the 3-dot
// TableActionMenu and the right-click FolderCardContextMenu in
// the shared FolderList). One resolver feeds both menus so they cannot
// diverge — the sidebar-nav `filterNavSections` / `settingsNavGating`
// convention. Unit-tested in `__tests__/folderMenuGating.test.ts`.

import type { SyncFolder } from "@/app/lib/types/sync-folder";
import { canManageDrive, type DriveRole } from "@/app/lib/shared-drives/roles";

export interface FolderMenuFlags {
  /** `SHARED_DRIVES_ENABLED` — passed in so the resolver stays pure. */
  sharedDrivesEnabled: boolean;
  /**
   * Kept for callers that still pass it, and deliberately unread.
   *
   * The plan no longer decides whether "Share drive…" APPEARS: the mint
   * dialog turns a plan without the perk into an upgrade prompt, so the
   * feature stays discoverable. Removing the field would be a churn of call
   * sites for no behaviour.
   */
  planSupportsSharedDrives?: boolean;
  /**
   * The viewer's role on THIS drive, when it is one shared with them.
   *
   * A manager may invite on a drive they do not own -- the server admits a
   * delegated manager by name -- so member-ness alone cannot decide whether
   * to offer the mint. Absent for an own drive, and for a member drive whose
   * role has not arrived yet, which stays conservative and offers nothing.
   */
  role?: DriveRole;
}

/**
 * Which gated items a folder row's menus show, and how the remove item
 * reads. The ungated items (Browse / Pause-Resume / Open in Finder) are
 * not represented here — they render for every row unconditionally.
 */
export interface FolderMenuPlan {
  /**
   * "Share drive…" — an own drive, or one this account manages for somebody
   * else. Gated on the flag either way.
   */
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
  removeItemTitle: "Stop syncing on this device" | "Leave shared drive";
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
 * the folder list, the cosmetic owner badge) stays hidden until the
 * feature ships, since minting invites against a feature-off server is a
 * dead control.
 *
 * The PLAN gate sits alongside it, for the same reason at a different layer:
 * a plan without the perk is refused by the server with
 * `shared_drives_not_entitled`, so offering the item to a Starter account is
 * a click that can only end in an upgrade prompt. It defaults to permitted,
 * so an account whose plan has not loaded keeps the item rather than watching
 * it appear a moment later.
 */
export function resolveFolderMenuPlan(
  folder: Pick<SyncFolder, "ownerSs58">,
  flags: FolderMenuFlags,
): FolderMenuPlan {
  const member = isMemberDrive(folder);

  return {
    // NOT gated on the plan. Hiding it from a plan without the perk hid the
    // feature's existence from exactly the people who would pay for it, and
    // left them no way to discover why other accounts had it. The mint
    // dialog answers instead, opening straight into an upgrade prompt that
    // names the plans -- one click, no wasted round trip, and the feature is
    // visible to everyone.
    showShareDrive: flags.sharedDrivesEnabled && canManageDrive({ isOwner: !member, role: flags.role }),
    showExclusions: !member,
    showDeleteFromServer: !member,
    removeItemTitle: member ? "Leave shared drive" : "Stop syncing on this device",
    removeIsLeave: member,
  };
}
