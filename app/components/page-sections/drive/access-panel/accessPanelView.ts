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

/**
 * How many rows each group draws in the panel's main view before its
 * "Show all" row. A big drive has 100 people and 100 links; five of each
 * keeps every group, and the jump bar above them, on one screen, and the
 * whole list lives one tap away in the group's full view.
 */
export const PANEL_GROUP_PREVIEW = 5;

/** More people than this and the main view offers a search field. */
export const MAIN_SEARCH_MIN_PEOPLE = 10;

/** The rows a group draws now, and how many wait behind "Show all". */
export function capRows<T>(rows: readonly T[], expanded: boolean, cap: number = PANEL_GROUP_PREVIEW): { shown: T[]; hidden: number } {
  if (expanded || rows.length <= cap) return { shown: [...rows], hidden: 0 };
  return { shown: rows.slice(0, cap), hidden: rows.length - cap };
}

/** The panel's three groups, as the jump bar and the full views name them. */
export type PanelGroup = "people" | "pending" | "links";

/** One row of the People group. */
export type PanelPerson =
  | { kind: "owner"; ss58: string; isYou: boolean; name?: string }
  | { kind: "member"; member: AccessPanelMember }
  | { kind: "holder"; holder: AccessPanelHolder };

function personIsYou(p: PanelPerson): boolean {
  if (p.kind === "owner") return p.isYou;
  return p.kind === "member" ? p.member.isYou : p.holder.isYou;
}

/** A stable key for a person's row (a holder can share an ss58 with nobody). */
export function personKey(p: PanelPerson): string {
  if (p.kind === "owner") return "owner";
  return p.kind === "member" ? p.member.memberSs58 : `holder:${p.holder.memberSs58}`;
}

/**
 * The People group in drawing order: the owner, you, then everyone else as
 * Rust sent them (members most recently joined first, then folder holders).
 * Only arranges the rows Rust already ordered; decides nothing.
 */
export function panelPeople(panel: AccessPanel, ownerName?: string): PanelPerson[] {
  const owner: PanelPerson = { kind: "owner", ss58: panel.ownerSs58, isYou: panel.ownerIsYou, name: ownerName };
  const rest: PanelPerson[] = [
    ...panel.members.map((member): PanelPerson => ({ kind: "member", member })),
    ...panel.folderHolders.map((holder): PanelPerson => ({ kind: "holder", holder })),
  ];
  return [owner, ...rest.filter(personIsYou), ...rest.filter((p) => !personIsYou(p))];
}

/** A search as typed, ready to compare: trimmed and lower case. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function anyIncludes(q: string, fields: Array<string | null | undefined>): boolean {
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(q));
}

/** Whether a person matches a search, by name, email or address. */
export function personMatches(p: PanelPerson, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  if (p.kind === "owner") return anyIncludes(q, [p.name, p.ss58]);
  const who = p.kind === "member" ? p.member : p.holder;
  return anyIncludes(q, [who.memberName, who.memberEmail, who.memberSs58]);
}

/** Whether an emailed invitation matches a search, by its address. */
export function pendingMatches(invite: { recipientEmail?: string }, query: string): boolean {
  const q = normalizeQuery(query);
  return !q || anyIncludes(q, [invite.recipientEmail]);
}

/** Whether a link matches a search, by who made it or the role it gives. */
export function linkMatches(link: AccessPanelLink, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  return anyIncludes(q, [linkTitle(link), linkCreator(link), link.mintedByName, link.mintedBy]);
}

/** The People full view's filter chips. */
export type PeopleFilter = "all" | "viewer" | "editor" | "folder";
export const PEOPLE_FILTERS: ReadonlyArray<{ id: PeopleFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "viewer", label: "Viewer" },
  { id: "editor", label: "Editor" },
  { id: "folder", label: "Folder access" },
];

/** Whether a person is in a People chip. The owner is only in All. */
export function personInFilter(p: PanelPerson, filter: PeopleFilter): boolean {
  if (filter === "all") return true;
  if (p.kind === "owner") return false;
  if (filter === "folder") return p.kind === "holder";
  const role = parseDriveRole(p.kind === "member" ? p.member.role : p.holder.role);
  return filter === "viewer" ? role === "reader" : role === "writer";
}

/** The Links full view's filter chips. */
export type LinksFilter = "active" | "ended";
export const LINKS_FILTERS: ReadonlyArray<{ id: LinksFilter; label: string }> = [
  { id: "active", label: "Active" },
  { id: "ended", label: "Ended" },
];

/** A group's name in the jump bar and the full view's sub-header. */
export const GROUP_TITLE: Record<PanelGroup, string> = {
  people: "People",
  pending: "Pending invites",
  links: "Links",
};

/** The jump bar's short name for a group. */
export const GROUP_SHORT: Record<PanelGroup, string> = {
  people: "People",
  pending: "Pending",
  links: "Links",
};

/** "Show all 82 people", "Show all 6 pending invites", "Show all 45 links". */
export function showAllLabel(group: PanelGroup, total: number): string {
  const noun =
    group === "people"
      ? total === 1 ? "person" : "people"
      : group === "pending"
        ? `pending invite${total === 1 ? "" : "s"}`
        : `link${total === 1 ? "" : "s"}`;
  return `Show all ${total} ${noun}`;
}

/** The empty line when a search matches nothing. */
export function noMatchLine(query: string): string {
  return `No one matches “${query.trim()}”`;
}

/** The search field's placeholder in each view. */
export const SEARCH_PLACEHOLDER: Record<PanelGroup | "main", string> = {
  main: "Search people, invites and links",
  people: "Search by name, email or address",
  pending: "Search by email",
  links: "Search by creator or role",
};

/** Copy for the panel. One place, shared with the tests. */
export const ACCESS_PANEL_COPY = {
  changesApply: "Changes apply right away.",
  emptyTitle: "Only you have access",
  emptyBody: (folder: boolean) =>
    `Invite people by email or create a link to share this ${folder ? "folder" : "drive"}.`,
  linksLocked: "Links are locked. Enter your unlock password to show and copy them.",
} as const;
