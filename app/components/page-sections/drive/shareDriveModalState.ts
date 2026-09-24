// Pure state resolvers for `ShareDriveModal` — the sidebarSearchState
// convention: the component stays declarative and the view routing is
// unit-testable without a render. Tested in
// `__tests__/shareDriveModalState.test.ts`.

import { DRIVE_ROLES, type DriveRole } from "@/app/lib/shared-drives/roles";

/**
 * Invite-tab lifecycle. Mirrors `ShareFileModal`'s machine minus progress
 * (an invite mint is one short HTTP call, not an upload), plus the
 * `unavailable` terminal for a feature-off server — a degrade, not an
 * error, so it gets its own quiet copy and no retry button.
 */
export type InviteState =
  | { kind: "choosing" }
  | { kind: "running" }
  | { kind: "done"; inviteUrl: string }
  // A mailed invitation: there is no link to show, only who it went to.
  | { kind: "emailSent"; email: string }
  | { kind: "unavailable" }
  // The mint plan gate: the owner's plan does not include shared drives. A
  // terminal upgrade state, not an error — its own copy and CTA, no retry.
  | { kind: "notEntitled" }
  // The server has folder invites off (or predates them): sharing a single
  // folder is coming soon. Terminal, never a fallback to a drive invite.
  | { kind: "folderComingSoon" }
  | { kind: "error"; message: string };

/**
 * A "coming soon" shown inline beside the choice it is about, keyed by the
 * structured refusal Rust returned (never by the message text).
 */
export type ComingSoonNotice = "email" | "folderEmail" | "folderEditor";

/**
 * The words for each "coming soon". The same sentences are the Rust
 * `NotReadyKind` Display texts (`src-tauri/src/error.rs`); a test pins the
 * two together so neither side can reword alone.
 */
export const COMING_SOON_COPY: Record<ComingSoonNotice | "folder", string> = {
  email: "Email invites are coming soon. For now, copy the invite link and send it yourself.",
  folderEmail:
    "Email invites for a single folder are coming soon. For now, copy the invite link and send it yourself.",
  folderEditor:
    "Editor access for a single folder is coming soon. You can share it as view only for now.",
  folder: "Sharing a single folder is coming soon.",
};

/**
 * "Never expires", expressed as the hcfs server's 100-year lifetime cap —
 * the server keeps `expires_at` a plain timestamp, and clients that want a
 * non-expiring invite send exactly the cap value
 * (`hcfs-server/handlers/drive_invites.rs::MAX_EXPIRES_SECS`). Teams asked
 * for standing invite links (2026-08-24), superseding the v1 "every preset
 * expires" stance; access is still revocable per member from the Members
 * tab.
 */
export const NEVER_EXPIRES_SECS = 100 * 365 * 24 * 60 * 60;

/** Invite lifetimes offered by the expiry row. */
export const INVITE_TTL_OPTIONS: ReadonlyArray<{ label: string; secs: number }> = [
  { label: "24 hours", secs: 24 * 60 * 60 },
  { label: "7 days", secs: 7 * 24 * 60 * 60 },
  { label: "30 days", secs: 30 * 24 * 60 * 60 },
  { label: "Never expires", secs: NEVER_EXPIRES_SECS },
];

/**
 * Lifetimes a MAILED invitation may carry. The server takes one hour to
 * thirty days, so "Never expires" is not offered (Rust refuses it by name).
 */
export const EMAIL_INVITE_TTL_OPTIONS: ReadonlyArray<{ label: string; secs: number }> =
  INVITE_TTL_OPTIONS.filter((o) => o.secs <= 30 * 24 * 60 * 60);

/**
 * Roles an emailed invitation may confer: Viewer and Editor, the same two a
 * link offers. Rust refuses anything else before a request.
 */
export const EMAIL_INVITE_ROLES: ReadonlyArray<DriveRole> = DRIVE_ROLES;

/**
 * Roles a FOLDER may be shared with: Viewer and Editor. Mirrors
 * `folder_roles::FOLDER_ROLES` in Rust.
 */
export const FOLDER_INVITE_ROLES: ReadonlyArray<DriveRole> = DRIVE_ROLES;

/**
 * Lifetimes a folder invite may carry: at most 30 days (the server's cap),
 * so "Never expires" is not offered. Always single use, so there is no uses
 * choice at all.
 */
export const FOLDER_INVITE_TTL_OPTIONS: ReadonlyArray<{ label: string; secs: number }> =
  INVITE_TTL_OPTIONS.filter((o) => o.secs <= 30 * 24 * 60 * 60);

/** Keep a picked lifetime inside what a folder invite allows. */
export function clampFolderInviteTtl(secs: number): number {
  return FOLDER_INVITE_TTL_OPTIONS.some((o) => o.secs === secs)
    ? secs
    : DEFAULT_INVITE_TTL_SECS;
}

/** Keep a picked lifetime inside what an emailed invitation allows. */
export function clampEmailInviteTtl(secs: number): number {
  return EMAIL_INVITE_TTL_OPTIONS.some((o) => o.secs === secs)
    ? secs
    : DEFAULT_INVITE_TTL_SECS;
}

/**
 * The preset selected when the dialog opens — 7 days, mirroring the Rust
 * policy default (`shared_drives/commands.rs::resolve_invite_policy`).
 * Purely a DISPLAY concern: the modal always sends its selection
 * explicitly, and an IPC caller that omits the param gets the Rust
 * default regardless of this value.
 */
export const DEFAULT_INVITE_TTL_SECS = 7 * 24 * 60 * 60;

/**
 * "Joined Aug 20, 2026" — fixed en-US like the folder rows' date column,
 * so tests don't depend on the runner's locale. `null` for an unparseable
 * timestamp: the row then omits the line instead of showing
 * "Invalid Date".
 */
export function formatJoinedDate(rfc3339: string): string | null {
  const ts = Date.parse(rfc3339);
  if (Number.isNaN(ts)) return null;
  const d = new Date(ts);
  const month = d.toLocaleString("en-US", { month: "short" });
  return `${month} ${d.getDate()}, ${d.getFullYear()}`;
}
