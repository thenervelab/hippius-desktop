// Words for the Manage access panel. Pure, so the copy is tested without a
// render (the sidebarSearchState convention).
//
// Nothing here decides anything: who is in the drive, which links still
// work, how many uses are left and how long until a link expires all come
// from Rust (`list_access_panel`). These only put those answers into words.
// The web console's panel uses the same words, so keep them in step.

import type {
  AccessPanel,
  AccessPanelHolder,
  AccessPanelLink,
  AccessPanelLinkStatus,
  AccessPanelMember,
} from "@/app/lib/tauri/sharedDrives";
import { accountDisplayName } from "@/app/lib/shared-drives/accountLabel";
import { driveRoleLabel, parseDriveRole } from "@/app/lib/shared-drives/roles";
import { formatJoinedDate } from "../shareDriveModalState";

const HOUR = 3600;
const DAY = 24 * HOUR;

/** "5 days", "1 day", "20 hours", "1 hour", "less than an hour". */
export function durationWords(secs: number): string {
  const days = Math.floor(secs / DAY);
  if (days >= 2) return `${days} days`;
  if (days === 1) return "1 day";
  const hours = Math.floor(secs / HOUR);
  if (hours >= 2) return `${hours} hours`;
  if (hours === 1) return "1 hour";
  return "less than an hour";
}

/** "a Viewer", "an Editor" (a wire `manager` reads as an Editor). */
export function rolePhrase(role: string): string {
  const label = driveRoleLabel(parseDriveRole(role));
  return /^[AEIOU]/.test(label) ? `an ${label}` : `a ${label}`;
}

/** "Plus plan" from the plan's name, or null when there is none. */
export function planLabel(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return /\bplan$/i.test(trimmed) ? trimmed : `${trimmed} plan`;
}

/**
 * The line under the panel's title.
 *
 * By ownership, not by role: anyone on somebody else's drive is told whose
 * drive it is and their role there, and the plan belongs to that owner, so it
 * is never quoted.
 */
export function panelSubline(params: {
  folder: boolean;
  ownerIsYou: boolean;
  driveName: string;
  ownerName: string;
  yourRole: string | null;
  planName: string | null;
}): string {
  if (!params.ownerIsYou) {
    const by = `Shared with you by ${params.ownerName}`;
    const role = params.yourRole && params.yourRole !== "owner" ? rolePhrase(params.yourRole) : null;
    return role ? `${by} · you are ${role}` : by;
  }
  if (params.folder) return `Folder in ${params.driveName}`;
  return params.planName ? `Your drive · ${params.planName}` : "Your drive";
}

/** Everyone the People group lists: the owner, members and folder holders. */
export function peopleCount(panel: AccessPanel): number {
  return 1 + panel.members.length + panel.folderHolders.length;
}

/** Nobody but the owner, and nothing on the way: the panel's empty state. */
export function isOnlyOwner(panel: AccessPanel): boolean {
  return (
    panel.ownerIsYou &&
    panel.members.length === 0 &&
    panel.folderHolders.length === 0 &&
    panel.pendingInvites.length === 0 &&
    panel.links.length === 0
  );
}

/** A member's second line: their email, else when they joined. */
export function memberMeta(member: AccessPanelMember, folderPanel: boolean): string | null {
  if (folderPanel) return "Has the whole drive";
  if (member.memberEmail) return member.memberEmail;
  const joined = formatJoinedDate(member.createdAt);
  return joined ? `Joined ${joined}` : null;
}

/** The folder tag on a holder's row: "Clients/ACME", or "Clients/ACME +1". */
export function holderFolderTag(holder: AccessPanelHolder): string {
  const more = holder.folders.length - 1;
  return more > 0 ? `${holder.pathPrefix} +${more}` : holder.pathPrefix;
}

/** How an emailed invitation's pill reads, by how far it has got. */
export function pendingStage(status: string | undefined): string {
  if (status === "awaiting_seal") return "Needs approval";
  if (status === "sealed") return "Approved";
  return "Invite sent";
}

/** "6 days left", or null for an unreadable expiry. */
export function pendingLeft(expiresInSecs: number | null): string | null {
  if (expiresInSecs === null) return null;
  return `${durationWords(Math.max(0, expiresInSecs))} left`;
}

/** "Editor link". */
export function linkTitle(link: AccessPanelLink): string {
  return `${driveRoleLabel(parseDriveRole(link.role))} link`;
}

/** Who made a link: "You", their name or short address, or null if unknown. */
export function linkCreator(link: AccessPanelLink): string | null {
  if (link.mintedByYou) return "You";
  if (!link.mintedBy.trim()) return null;
  return accountDisplayName(link.mintedBy, link.mintedByName, 14);
}

/** "12 of 50 used", or for a single-use link whether it was used. */
export function linkUsage(link: AccessPanelLink): string {
  if (link.singleUse) return link.useCount > 0 ? "Used" : "Single use, not used yet";
  return `${link.useCount} of ${link.maxUses} used`;
}

/** "Expires in 5 days", "Never expires", or null when Rust did not say. */
export function linkExpiry(link: AccessPanelLink): string | null {
  if (link.neverExpires) return "Never expires";
  if (link.expiresInSecs === null) return null;
  return `Expires in ${durationWords(Math.max(0, link.expiresInSecs))}`;
}

/** The usage line under a working link. */
export function linkMeta(link: AccessPanelLink): string {
  return [linkUsage(link), linkExpiry(link)].filter(Boolean).join(" · ");
}

/** Why an ended link no longer works. */
export function linkEndedLabel(status: AccessPanelLinkStatus): string {
  switch (status) {
    case "revoked":
      return "Revoked";
    case "used_up":
      return "All uses taken";
    case "expired":
      return "Expired";
    default:
      return "";
  }
}

/** The folded line for links that no longer work. */
export function endedLinksLine(count: number): string {
  return `${count} expired or revoked link${count === 1 ? "" : "s"}`;
}

/** Copy for the panel. One place, shared with the tests. */
export const ACCESS_PANEL_COPY = {
  changesApply: "Changes apply right away.",
  emptyTitle: "Only you have access",
  emptyBody: (folder: boolean) =>
    `Invite people by email or create a link to share this ${folder ? "folder" : "drive"}.`,
  linksLocked: "Links are locked. Enter your unlock password to show and copy them.",
} as const;
