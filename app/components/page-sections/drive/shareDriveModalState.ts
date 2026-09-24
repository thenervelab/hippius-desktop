// Pure state resolvers for `ShareDriveModal` — the sidebarSearchState
// convention: the component stays declarative and the view routing is
// unit-testable without a render. Tested in
// `__tests__/shareDriveModalState.test.ts`.

import type {
  DriveInviteInfo,
  DriveMemberInfo,
  DriveFolderGrantInfo,
} from "@/app/lib/tauri/sharedDrives";
import {
  MANAGER_INVITE_MAX_SECONDS,
  type DriveRole,
} from "@/app/lib/shared-drives/roles";

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
 * Members-tab data lifecycle. `idle` means the tab has never been opened
 * this session — the fetch is lazy so minting an invite costs no member
 * listing round-trip.
 */
export type MembersState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ready";
      members: DriveMemberInfo[];
      /** Folder-grant holders; empty when the server omits them. */
      folderGrants: DriveFolderGrantInfo[];
    }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export type InvitesState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; invites: DriveInviteInfo[] }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

/**
 * Same five-state shape as members, deliberately: both tabs load the same way
 * against the same server, so one reader can learn one shape.
 */
export function getInvitesView(state: InvitesState): MembersView {
  switch (state.kind) {
    case "loading":
    case "idle":
      return "loading";
    case "unavailable":
      return "unavailable";
    case "error":
      return "error";
    default:
      return state.invites.length === 0 ? "empty" : "rows";
  }
}

export type MembersView = "loading" | "rows" | "empty" | "unavailable" | "error";

/**
 * Which members-tab body renders. `idle` maps to `loading` — by the time
 * anything is on screen the activation effect has started the fetch, and
 * rendering a skeleton for the one frame in between beats a flash of the
 * empty state.
 */
export function getMembersView(state: MembersState): MembersView {
  switch (state.kind) {
    case "idle":
    case "loading":
      return "loading";
    case "ready": {
      const hasPeople =
        state.members.length > 0 || state.folderGrants.length > 0;
      return hasPeople ? "rows" : "empty";
    }
    case "unavailable":
      return "unavailable";
    case "error":
      return "error";
  }
}

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
 * The lifetimes a link of this role may actually carry.
 *
 * A manager invite is hard-capped by the server at 24 hours, and both the
 * Rust mint and the console clamp anything wider. Offering "7 days" /
 * "Never expires" for a manager would still mint a working link, but the
 * done dialog would describe the lifetime the user picked rather than the
 * one that was sent — so the chooser stops offering them (console
 * `inviteTtlOptionsFor`).
 */
export function inviteTtlOptionsFor(
  role: DriveRole,
): ReadonlyArray<{ label: string; secs: number }> {
  return role === "manager"
    ? INVITE_TTL_OPTIONS.filter((o) => o.secs <= MANAGER_INVITE_MAX_SECONDS)
    : INVITE_TTL_OPTIONS;
}

/**
 * Pull a chosen lifetime back inside what the role allows.
 *
 * Needed because the role is picked after the lifetime: choosing Manager
 * with "30 days" already selected must move the selection, not leave a
 * value on screen that the mint would quietly replace.
 */
export function clampInviteTtl(role: DriveRole, secs: number): number {
  const allowed = inviteTtlOptionsFor(role);
  return allowed.some((o) => o.secs === secs)
    ? secs
    : (allowed[allowed.length - 1]?.secs ?? DEFAULT_INVITE_TTL_SECS);
}

/**
 * Lifetimes a MAILED invitation may carry. The server takes one hour to
 * thirty days, so "Never expires" is not offered (Rust refuses it by name).
 */
export const EMAIL_INVITE_TTL_OPTIONS: ReadonlyArray<{ label: string; secs: number }> =
  INVITE_TTL_OPTIONS.filter((o) => o.secs <= 30 * 24 * 60 * 60);

/**
 * Roles an emailed invitation may confer. A Manager invite has to be a link:
 * the server caps those at a day, and a mailed one would expire before it
 * could be approved.
 */
export const EMAIL_INVITE_ROLES: ReadonlyArray<Exclude<DriveRole, "manager">> = [
  "reader",
  "writer",
];

/**
 * Roles a FOLDER may be shared with: Viewer and Editor. Manager is not a
 * folder role (HCFS #475). Mirrors `folder_roles::FOLDER_ROLES` in Rust.
 */
export const FOLDER_INVITE_ROLES: ReadonlyArray<Exclude<DriveRole, "manager">> = [
  "reader",
  "writer",
];

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

/** One person in the Folder access list, with every folder they hold. */
export interface FolderGrantHolder {
  memberSs58: string;
  memberName?: string;
  memberEmail?: string;
  /** Their role: `reader` (Viewer) or `writer` (Editor). */
  role: string;
  folders: string[];
  createdAt: string;
}

/**
 * Group folder grants by holder, so one person with two folders is one row
 * and one remove target. Keyed by ss58, the identity; the name is display
 * only. Folders sorted for a stable row.
 */
export function groupFolderGrantsByHolder(
  grants: readonly DriveFolderGrantInfo[],
): FolderGrantHolder[] {
  const byHolder = new Map<string, FolderGrantHolder>();
  for (const g of grants) {
    const existing = byHolder.get(g.memberSs58);
    if (existing) {
      if (!existing.folders.includes(g.pathPrefix)) existing.folders.push(g.pathPrefix);
      existing.memberName ??= g.memberName;
      existing.memberEmail ??= g.memberEmail;
      if (!existing.createdAt || g.createdAt < existing.createdAt) existing.createdAt = g.createdAt;
    } else {
      byHolder.set(g.memberSs58, {
        memberSs58: g.memberSs58,
        memberName: g.memberName,
        memberEmail: g.memberEmail,
        role: g.role,
        folders: [g.pathPrefix],
        createdAt: g.createdAt,
      });
    }
  }
  return [...byHolder.values()].map((h) => ({ ...h, folders: [...h.folders].sort() }));
}
