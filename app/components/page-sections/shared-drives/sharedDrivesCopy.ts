// The words on the Shared Drives page's empty, upgrade and error states.
// Pure so every state's copy is pinned without a render
// (`__tests__/sharedDrivesCopy.test.ts`).
//
// The plan rule itself is Rust's (`billing/sharing_entitlement.rs`, sent as
// `canShareDrives`); these only say it. Sharing your own drives is on Plus,
// Max and Scale; joining a drive somebody else shares is open on every plan,
// Free included, because the owner pays for everything in it. The plan names
// are the ones the Share dialog's upgrade card already uses.

import type { SharedDrivesFilter } from "./sharedDrivesState";

export const SHARE_A_DRIVE_LABEL = "Share a drive";
export const UPGRADE_PLAN_LABEL = "Upgrade plan";
export const TRY_AGAIN_LABEL = "Try again";

/** The lowest plan that shares, on the header button's pill. */
export const SHARING_PLAN_PILL = "Plus";

/** What the header button says about itself on a plan without sharing. */
export const SHARING_PLAN_REQUIREMENT = "Sharing is available on Plus, Max and Scale plans.";
export const SHARING_UPGRADE_HINT = `${SHARING_PLAN_REQUIREMENT} Upgrade to invite people into your drives.`;

export const SHARE_A_DRIVE_EMPTY_TITLE = "A place for teamwork";
export const SHARE_A_DRIVE_EMPTY_LINE =
  "Share a drive to work on the same encrypted files with your team. Drives other people share with you show up here too.";
export const SHARE_A_DRIVE_UPGRADE_LINE =
  "Sharing your own drives is included with Plus, Max and Scale. Drives other people share with you show up here on any plan.";

export interface EmptyStateCopy {
  title: string;
  description: string;
  /** The card's button: start sharing, upgrade, or nothing to do here. */
  action: "share" | "upgrade" | null;
}

/**
 * What an empty list says, by tab and by whether the plan shares.
 *
 * - Nothing either way: what a shared drive is for, and the way to start
 *   one (or the plan that includes it, and that joining is open anyway).
 * - "Shared with you" empty: where drives others invite you into will
 *   appear. Nothing to click, since it is somebody else's move; on a plan
 *   without sharing it adds that joining works on any plan.
 * - "Shared by you" empty: share one of your drives, or the upgrade.
 */
export function sharedDrivesEmptyCopy(scope: SharedDrivesFilter, canShare: boolean): EmptyStateCopy {
  if (scope === "with-you") {
    return {
      title: "Nothing shared with you yet",
      description: canShare
        ? "When someone invites you into one of their drives or folders, it shows up here."
        : "When someone invites you into one of their drives or folders, it shows up here. You can join on any plan.",
      action: null,
    };
  }
  if (scope === "by-you") {
    return canShare
      ? {
          title: "You haven't shared a drive yet",
          description: "Share one of your drives to work on the same encrypted files with your team.",
          action: "share",
        }
      : {
          title: SHARING_PLAN_REQUIREMENT,
          description:
            "Upgrade to invite people into your drives. Drives other people share with you stay open on any plan.",
          action: "upgrade",
        };
  }
  return {
    title: SHARE_A_DRIVE_EMPTY_TITLE,
    description: canShare ? SHARE_A_DRIVE_EMPTY_LINE : SHARE_A_DRIVE_UPGRADE_LINE,
    action: canShare ? "share" : "upgrade",
  };
}

/**
 * What a list that could not load says. Never "nothing shared": the page
 * does not know. Offline, it says so and that it will load once the
 * connection is back (the page retries by itself then); otherwise the
 * server did not answer. Either way the files are fine, which is the first
 * thing somebody wonders.
 */
export function sharedDrivesErrorCopy(scope: SharedDrivesFilter, offline: boolean): { title: string; description: string } {
  const title =
    scope === "with-you"
      ? "Couldn't load drives shared with you"
      : scope === "by-you"
        ? "Couldn't load the drives you've shared"
        : "Couldn't load shared drives";
  return {
    title,
    description: offline
      ? "Your computer is offline. Your drives and files are safe, and this list loads again once you're back online."
      : "The server didn't answer. Your drives and files are safe. Try again in a moment.",
  };
}

/**
 * The line above the rows when one kind failed and the other has rows to
 * show, so a short list is never read as the whole list.
 */
export function sharedDrivesPartialErrorLine(failed: ReadonlyArray<"by-you" | "with-you">): string {
  if (failed.length > 1) return "Some shared drives couldn't load.";
  return failed[0] === "with-you"
    ? "Drives shared with you couldn't load, so they're missing from this list."
    : "The drives you've shared couldn't load, so they're missing from this list.";
}
