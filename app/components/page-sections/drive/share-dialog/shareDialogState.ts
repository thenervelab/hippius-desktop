// Pure view helpers for the Share dialog, kept out of the components so the
// routing is testable without a render (the sidebarSearchState convention).
// Nothing here decides policy: Rust validates, caps and words every refusal,
// and these only choose which of those answers to show where.

import {
  isDriveFull,
  isEmailInvitesUnavailable,
  isFolderEditorInvitesUnavailable,
  isFolderEmailInvitesUnavailable,
  isFolderInvitesUnavailable,
  isSharedDrivesNotEntitled,
  isSharedDrivesUnavailable,
} from "@/app/lib/tauri/sharedDrives";
import { errorMessage } from "@/lib/utils/errorUtils";
import { driveRoleLabel, type DriveRole } from "@/app/lib/shared-drives/roles";
import { expiresInWords, secsUntil, timeLeft } from "@/app/lib/shared-drives/timeLeft";
import {
  COMING_SOON_COPY,
  INVITE_TTL_OPTIONS,
  NEVER_EXPIRES_SECS,
} from "../shareDriveModalState";

/**
 * What a section says inline after a refusal or a success. Never only a
 * toast: the message sits beside the thing it is about, and stays until the
 * next attempt.
 */
export type SectionNotice =
  /** A "coming soon", in the amber note style. Not an error. */
  | { kind: "comingSoon"; text: string }
  /** Editor on one folder is coming soon; offers to go ahead as Viewer. */
  | { kind: "folderEditor" }
  /** The owner's plan does not include sharing: the upgrade prompt. */
  | { kind: "notEntitled" }
  /**
   * Rust refused the invite because the drive is full (`DRIVE_FULL`).
   * Nothing was sent; the dialog's warning above says why and what to do.
   */
  | { kind: "driveFull" }
  /** Anything Rust worded for the user: rate limit, failed send, bad input. */
  | { kind: "error"; message: string };

/**
 * Whether the Share dialog and the Manage access panel offer the controls
 * that ADD people (email invite, invite link, Approve, Change folders):
 *
 * - `allowed`: offer them.
 * - `upgrade`: the plan does not include sharing, so an upgrade card stands
 *   in their place. People already shared with stay listed and removable.
 * - `loading`: the plan is not known yet, so a skeleton stands there, and
 *   neither the controls nor the card flash.
 *
 * `planAllows` is Rust's `canShareDrives` (undefined while loading).
 * `refusedByServer` is a 403 `shared_drives_not_entitled` from any sharing
 * command, which wins over a stale or unknown plan. The plan asked about is
 * this account's, so it only gates a drive this account owns: somebody
 * else's drive is decided by its owner.
 */
export type SharingGate = "loading" | "allowed" | "upgrade";

export function sharingGate(params: {
  planAllows: boolean | undefined;
  owner: boolean;
  refusedByServer: boolean;
}): SharingGate {
  if (params.refusedByServer) return "upgrade";
  if (!params.owner) return "allowed";
  if (params.planAllows === undefined) return "loading";
  return params.planAllows ? "allowed" : "upgrade";
}

/**
 * What the Share dialog puts where the add-people controls go:
 *
 * - `none`: this account cannot add people here (a Viewer or an Editor).
 * - `loading`: the plan is not known yet.
 * - `upgrade`: the plan does not include sharing.
 * - `full`: the drive already holds as many people as the owner's plan
 *   allows (Rust's `capacity.full`). The warning goes first in the tab box
 *   and the controls stay, disabled: Create link always, Send and the role
 *   unless the address is someone already on the drive (no new place).
 *   Rust refuses anything else on the send (`DRIVE_FULL`) before any
 *   unlock.
 * - `allowed`: offer them.
 *
 * Room is known once the people list has loaded. Until then, and when it
 * failed, the controls stay up: the list arrives with the dialog's first
 * paint in practice, and holding every invite behind it would slow every
 * share for the rare full drive. The server still refuses a join past the
 * limit, so a drive the app could not size behaves as it always did.
 */
export type AddPeopleGate = "none" | SharingGate | "full";

export function addPeopleGate(params: {
  canManage: boolean;
  sharing: SharingGate;
  access: "loading" | "ready" | "unavailable" | "error";
  full: boolean;
}): AddPeopleGate {
  if (!params.canManage) return "none";
  if (params.sharing !== "allowed") return params.sharing;
  return params.access === "ready" && params.full ? "full" : "allowed";
}

/** "1 person", "8 people". */
export function peopleCount(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

/** The line every full-drive warning ends with. */
export const DRIVE_FULL_LINKS_NOTE =
  "Links you've already shared won't let anyone new in until there's room.";

/**
 * The words for a full drive: a title, the count against the limit, and
 * what to do. People never include the owner, so the count says "plus you"
 * to the owner and "plus the owner" to a Manager. After a downgrade the
 * count can pass the limit ("10 of 8 people"), which is said as it is. The
 * limit is the OWNER's plan: the owner is told to upgrade (with the way to
 * the plans), a Manager to remove someone or ask the owner.
 */
export function driveFullCopy(params: {
  ownerIsYou: boolean;
  memberLimit: number | null;
  people: number;
}): { title: string; body: string; linksNote: string; action: string | null } {
  const title = "This drive is full";
  const limit = params.memberLimit;
  // A plan with no shared drives at all: there is no count to give.
  if (limit === 0) {
    return {
      title,
      body: params.ownerIsYou
        ? "Your plan does not allow new people on shared drives. Upgrade your plan to add more."
        : "The drive owner\u2019s plan does not allow new people on shared drives. Ask the owner to upgrade their plan.",
      linksNote: DRIVE_FULL_LINKS_NOTE,
      action: params.ownerIsYou ? "Upgrade plan" : null,
    };
  }
  const plus = params.ownerIsYou ? "plus you" : "plus the owner";
  const count =
    limit === null
      ? `${peopleCount(params.people)}, ${plus}.`
      : `${params.people} of ${peopleCount(limit)}, ${plus}.`;
  const next = params.ownerIsYou
    ? "Upgrade your plan to add more."
    : "Remove someone, or ask the owner to upgrade their plan.";
  return {
    title,
    body: `${count} ${next}`,
    linksNote: DRIVE_FULL_LINKS_NOTE,
    action: params.ownerIsYou ? "Upgrade plan" : null,
  };
}

/**
 * Whether a typed address belongs to someone already on the drive, against
 * the list Rust sent (already trimmed and lowercased there). On a full drive
 * only such an invite can still be sent: it takes no new place. Rust makes
 * the same check again on the send.
 */
export function isOnDrive(emailsWithAccess: readonly string[], typed: string): boolean {
  const email = typed.trim().toLowerCase();
  return email.length > 0 && emailsWithAccess.includes(email);
}

/** Under the control that tried, when Rust refused it as full (red). */
export const DRIVE_FULL_NOT_SENT = "Nothing was sent. This drive is full.";

/** Copy for a server that has shared drives switched off. */
export const SHARED_DRIVES_UNAVAILABLE_COPY =
  "Shared drives aren't available on your server yet.";

/**
 * Route a refusal to its inline notice by the structured kind Rust returned,
 * never by the message text. A rate limit (429) and a failed send (502) are
 * already worded by Rust, wait included, so they pass through as errors.
 */
export function noticeForError(err: unknown): SectionNotice {
  if (isEmailInvitesUnavailable(err)) {
    return { kind: "comingSoon", text: COMING_SOON_COPY.email };
  }
  if (isFolderEmailInvitesUnavailable(err)) {
    return { kind: "comingSoon", text: COMING_SOON_COPY.folderEmail };
  }
  if (isFolderEditorInvitesUnavailable(err)) return { kind: "folderEditor" };
  if (isFolderInvitesUnavailable(err)) {
    return { kind: "comingSoon", text: COMING_SOON_COPY.folder };
  }
  if (isSharedDrivesUnavailable(err)) {
    return { kind: "comingSoon", text: SHARED_DRIVES_UNAVAILABLE_COPY };
  }
  if (isSharedDrivesNotEntitled(err)) return { kind: "notEntitled" };
  if (isDriveFull(err)) return { kind: "driveFull" };
  return { kind: "error", message: errorMessage(err) };
}

/** "Expires in 7 days", "Never expires", from the lifetime Rust sent. */
export function describeLinkLifetime(expiresInSecs: number): string {
  if (expiresInSecs >= NEVER_EXPIRES_SECS) return "Never expires";
  const preset = INVITE_TTL_OPTIONS.find((o) => o.secs === expiresInSecs);
  if (preset) return `Expires in ${preset.label}`;
  return expiresInWords(expiresInSecs);
}

/** "Single use" or "Up to 50 uses", from the uses count Rust sent. */
export function describeLinkUses(maxUses: number): string {
  return maxUses <= 1 ? "Single use" : `Up to ${maxUses} uses`;
}

/** The one line under a new link: who it makes them, how long, how often. */
export function describeCreatedLink(link: {
  role: DriveRole;
  expiresInSecs: number;
  maxUses: number;
}): string {
  return [
    driveRoleLabel(link.role),
    describeLinkLifetime(link.expiresInSecs),
    describeLinkUses(link.maxUses),
  ].join(" · ");
}

/**
 * What a link does, by who can use it and for how long: under the By link
 * controls and under a link just made.
 */
export function linkHint(params: { folder: boolean; neverExpires: boolean }): string {
  if (params.folder) return "Works once, for the first person who opens it.";
  if (params.neverExpires) return "Anyone with the link can join until you revoke it.";
  return "Anyone with the link can join until it expires.";
}

/**
 * The one line under the By link controls, by what the link can do. A
 * folder link and a manager link are single use; the words say so before it
 * is made.
 */
export function generalAccessNote(params: {
  folder: boolean;
  role: DriveRole;
  neverExpires: boolean;
}): string {
  if (!params.folder && params.role === "manager") {
    return "Works once and expires within 24 hours. Managers can invite and remove people.";
  }
  return linkHint(params);
}

/**
 * The extra line under the By email field while a Manager is picked, or null.
 * A mailed Manager invite is single use and expires within 24 hours, and
 * opening it does not extend it (HCFS #521), so the words say they have to
 * join by then. A folder never offers Manager.
 */
export function emailInviteNote(params: { folder: boolean; role: DriveRole }): string | null {
  if (params.folder || params.role !== "manager") return null;
  return "Works once and expires within 24 hours, so they need to join by then. Managers can invite and remove people.";
}

/**
 * "expires in 7 days", "expires in 5 hours", "expired", or null for an
 * unreadable date. Same words as Manage access (`timeLeft`), lower case
 * because it follows the stage on the row.
 */
export function expiresInLabel(expiresAt: string, now: Date = new Date()): string | null {
  const secs = secsUntil(expiresAt, now);
  if (secs === null) return null;
  const left = timeLeft(secs);
  if (left.kind === "never") return "never expires";
  if (left.kind === "expired") return "expired";
  return `expires in ${left.words}`;
}

/**
 * How far an emailed invitation has got, as its row says it. An opened
 * invitation is approved by the app on its own while the owner is signed in
 * (Rust's `shared_drives::auto_seal`); Approve stays on the row as the
 * fallback for when it cannot (a locked session).
 */
const PENDING_STAGE: Record<string, string> = {
  sent: "Invite sent",
  awaiting_seal: "Opened · they join while the app is open",
  sealed: "Approved, not joined yet",
};

/** "Invite sent · expires in 7 days" for a pending emailed invitation. */
export function pendingInviteMeta(
  invite: { emailStatus?: string | null; expiresAt: string },
  now: Date = new Date(),
): string {
  const stage = PENDING_STAGE[invite.emailStatus ?? ""] ?? "Invite sent";
  const expiry = expiresInLabel(invite.expiresAt, now);
  return expiry ? `${stage} · ${expiry}` : stage;
}

/** "1 person has access", "4 people have access". */
export function peopleHaveAccess(count: number): string {
  return count === 1 ? "1 person has access" : `${count} people have access`;
}

/**
 * Rows the People list shows at most. With more, the last row becomes
 * "+ N more · Manage access", which opens the panel.
 */
export const PEOPLE_MAX_ROWS = 6;

/** The line under a row whose change Rust refused. */
export function couldNotChangeAccess(who: string, reason: string): string {
  const why = reason.trim();
  return why ? `Couldn't change access for ${who}. ${why}` : `Couldn't change access for ${who}.`;
}

/**
 * The line a folder's people list ends with. There is no role change for a
 * folder holder (HCFS #475), so the list says what to do instead.
 */
export const FOLDER_ACCESS_HINT =
  "To change someone\u2019s access to this folder, remove them and invite them again.";
