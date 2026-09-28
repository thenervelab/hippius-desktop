// Pure rules for the "Share a drive" picker. Unit-tested in
// `__tests__/ShareDrivePicker.test.tsx`.

import type { DriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";

/** More drives than this and the list gets a search field. */
export const PICKER_SEARCH_THRESHOLD = 6;

/**
 * "Shared with 4", "Shared", "Not shared", or nothing while not known.
 *
 * "Shared" alone is a drive with invite links out and nobody in yet. A drive
 * missing from the sharing map is UNKNOWN (both of its listings failed, or
 * the answer has not landed), so it says nothing rather than "Not shared".
 */
export function driveSharingMeta(sharing: DriveSharing | undefined): string | null {
  if (!sharing) return null;
  if (sharing.memberCount > 0) return `Shared with ${sharing.memberCount}`;
  return sharing.totalInviteCount > 0 ? "Shared" : "Not shared";
}

/** The drives a search shows, by name, ignoring case. */
export function filterDrives(drives: readonly string[], query: string): readonly string[] {
  const q = query.trim().toLowerCase();
  return q ? drives.filter((d) => d.toLowerCase().includes(q)) : drives;
}

/**
 * The drive Continue shares: the reader's pick while it is on screen, else
 * the first drive shown. The common case (one drive) is then a single click,
 * and a pick the search has hidden never gets shared unseen.
 */
export function selectedDrive(shown: readonly string[], picked: string | null): string | null {
  if (picked !== null && shown.includes(picked)) return picked;
  return shown[0] ?? null;
}
