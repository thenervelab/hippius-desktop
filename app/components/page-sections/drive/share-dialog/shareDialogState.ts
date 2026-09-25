// Pure view helpers for the Share dialog, kept out of the components so the
// routing is testable without a render (the sidebarSearchState convention).
// Nothing here decides policy: Rust validates, caps and words every refusal,
// and these only choose which of those answers to show where.

import {
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
 * The one line under "Invite link", by what the link can do. A folder link
 * and a manager link are single use; the words say so before it is made.
 */
export function generalAccessNote(params: {
  folder: boolean;
  role: DriveRole;
  neverExpires: boolean;
}): string {
  if (params.folder) return "Works once, for the first person who opens it.";
  if (params.role === "manager") {
    return "Works once and expires within 24 hours. Managers can invite and remove people.";
  }
  if (params.neverExpires) return "Anyone with the link can join for as long as it exists.";
  return "Anyone with the link can join until it expires.";
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
