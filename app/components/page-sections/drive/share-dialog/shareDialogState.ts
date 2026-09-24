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
  const hours = Math.max(1, Math.round(expiresInSecs / 3600));
  if (hours < 48) return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `Expires in ${days} days`;
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

/** The warning under the link choices, by what the link can do. */
export function linkWarning(params: {
  folder: boolean;
  role: DriveRole;
  neverExpires: boolean;
}): string {
  if (params.folder) {
    return "Works once, for the first person who opens it. Share it only with someone you trust with this folder.";
  }
  if (params.role === "manager") {
    return "A manager link can only be used once and expires within 24 hours. Managers can invite and remove people, so the link itself is short-lived.";
  }
  if (params.neverExpires) {
    return "Anyone with the link can join for as long as it exists. Share it only with people you trust.";
  }
  return "Anyone with the link can join until it expires. Share it only with people you trust.";
}
