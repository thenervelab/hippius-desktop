// Typed wrappers around the Rust shared-drive IPC commands.
//
// The Rust source of truth lives at `src-tauri/src/shared_drives/`.
// This file is the only place in the FE that talks to those commands (the
// `shares.ts` convention), so swapping the wire shape is a one-file change.
//
// Feature-off servers: the shared-drive routes are mounted only under
// `HCFS_FEATURE_SHARED_DRIVES=1`; against a feature-off server the backend
// maps the unmounted routes to `NotReady(SHARED_DRIVES_UNAVAILABLE)`.
// Callers MUST match that subkind explicitly via
// {@link isSharedDrivesUnavailable} and hide/degrade the surface — never
// toast it as an error. `isExpectedNoSessionError` silences `NotReady`
// generally, so relying on generic error handling would swallow it without
// the surface reacting.

import { invoke } from "@tauri-apps/api/core";
import type { DriveRole } from "@/app/lib/shared-drives/roles";
import { isNotReady } from "@/app/lib/utils/dispatchTauriError";

/**
 * Result of a successful invite mint. The URL embeds the invite token (path)
 * and the folder-key entropy (`#k=` fragment) — Rust assembles it and neither
 * secret exists anywhere else, so treat the whole URL as a drive-access
 * capability: copy it for the user, never persist or log it.
 */
export interface DriveInviteLink {
  inviteUrl: string;
}

/** One row of the owner-side members table. */
export interface DriveMemberInfo {
  memberSs58: string;
  role: string;
  /** RFC 3339 timestamp of when the member joined. */
  createdAt: string;
  /** Display name (hcfs #455); absent when unknown. */
  memberName?: string;
  /** Email, only for owner/managers of the same drive. */
  memberEmail?: string;
}

/**
 * One drive shared WITH this account (a "Shared with me" row).
 *
 * `syncedLocally`/`localLabel` are joined in Rust against the local
 * `sync_paths` member rows, so the FE routes an already-synced row to the
 * drive (`localLabel` names it in the normal lists) instead of offering
 * "Sync locally" a second time. `localLabel` is `null` exactly when
 * `syncedLocally` is `false`.
 */
export interface DriveMembershipInfo {
  ownerSs58: string;
  /** Owner display name (hcfs #455); absent when unknown. */
  ownerName?: string;
  folderHash: string;
  displayLabel: string;
  role: string;
  /** RFC 3339 timestamp of when the membership was granted. */
  createdAt: string;
  syncedLocally: boolean;
  localLabel: string | null;
  /**
   * People on this drive (owner excluded). Omit / undefined means unknown —
   * never draw "0 members" from absence.
   */
  memberCount?: number;
  /** Owner account limited: uploads refused. */
  frozen?: boolean;
  frozenUntil?: string | null;
}

/** Result of {@link addSharedDrive}: the local drive label actually
 * allocated (`displayLabel` suffixed on collision, e.g. `team-docs-2`). */
export interface AddSharedDriveResult {
  label: string;
}

/**
 * Mint an invite link for an OWN drive. `label` is the local drive label;
 * the backend refuses a member drive's label as `Validation` (only the
 * owner can mint).
 *
 * Omitted options fall through to the RUST policy defaults (7 days / 50
 * uses — `shared_drives/commands.rs::resolve_invite_policy`), so the
 * invite policy holds for every IPC caller, not just this wrapper. The
 * modal's expiry preset row is a display concern only
 * (`shareDriveModalState.ts::DEFAULT_INVITE_TTL_SECS`).
 */
/**
 * Which drive a manage call addresses when there is no local label.
 *
 * A manager may hold a drive they never synced here; the label-keyed path
 * resolves a `sync_paths` row such a drive does not have, and the lenient
 * fallback then answers with THIS account's namespace. Naming the wire
 * identity is how those calls address the right drive.
 */
export interface DriveTarget {
  ownerSs58?: string | null;
  folderHash?: string | null;
}

/** The identity args every manage IPC accepts, normalised to nulls. */
function targetArgs(target?: DriveTarget) {
  return {
    ownerSs58: target?.ownerSs58 ?? null,
    folderHash: target?.folderHash ?? null,
  };
}

export async function createDriveInvite(
  label: string,
  opts?: {
    expiresInSecs?: number;
    maxUses?: number;
    role?: DriveRole;
    target?: DriveTarget;
    /**
     * Drive-relative folder for a folder invite. When set, Rust forces
     * reader / single-use / ≤30 days and puts the derived file key in `#k=`.
     */
    pathPrefix?: string;
  },
): Promise<DriveInviteLink> {
  return invoke<DriveInviteLink>("create_drive_invite", {
    label,
    expiresInSecs: opts?.expiresInSecs,
    maxUses: opts?.maxUses,
    role: opts?.role,
    pathPrefix: opts?.pathPrefix ?? null,
    ...targetArgs(opts?.target),
  });
}

/** List the members of an OWN drive. */
export async function listDriveMembers(
  label: string,
  target?: DriveTarget,
): Promise<DriveMemberInfo[]> {
  return invoke<DriveMemberInfo[]>("list_drive_members", {
    label,
    ...targetArgs(target),
  });
}

/** One folder grant on a drive (owner/manager view). */
export interface DriveFolderGrantInfo {
  memberSs58: string;
  pathPrefix: string;
  role: string;
  createdAt: string;
  memberName?: string;
  memberEmail?: string;
}

/**
 * Folder grants on a drive this account owns or manages. Empty when the
 * server does not advertise `folder_grants`.
 */
export async function listDriveFolderGrants(
  label: string,
  target?: DriveTarget,
): Promise<DriveFolderGrantInfo[]> {
  return invoke<DriveFolderGrantInfo[]>("list_drive_folder_grants", {
    label,
    ...targetArgs(target),
  });
}

/**
 * Replace the folders a grant holder may read. Removing every grant is
 * {@link removeDriveMember} instead.
 */
export async function replaceFolderGrants(
  label: string,
  memberSs58: string,
  pathPrefixes: string[],
  target?: DriveTarget,
): Promise<string[]> {
  return invoke<string[]>("replace_folder_grants", {
    label,
    memberSs58,
    pathPrefixes,
    ...targetArgs(target),
  });
}

/**
 * Remove a member from an OWN drive (revocation of access — the member's
 * drive surfaces the revoked state on its next sync cycle).
 */
export async function removeDriveMember(
  label: string,
  memberSs58: string,
  target?: DriveTarget,
): Promise<void> {
  await invoke<void>("remove_drive_member", {
    label,
    memberSs58,
    ...targetArgs(target),
  });
}

/**
 * Change a member's role on an OWN drive.
 *
 * The new role binds on the member's very next request, so nothing here has
 * to warn about propagation. Two refusals come back as `Validation` and are
 * worth surfacing verbatim: targeting yourself (a manager leaves rather than
 * demoting themself) and a role outside the server's vocabulary.
 *
 * A downward change is sticky — the server revokes the invite that admitted
 * the member when that link still outranks the new role, and demoting a
 * manager revokes every live invite they minted, so a spare link cannot
 * re-escalate them.
 */
export async function changeDriveMemberRole(
  label: string,
  memberSs58: string,
  role: DriveRole,
  target?: DriveTarget,
): Promise<void> {
  await invoke<void>("change_drive_member_role", {
    label,
    memberSs58,
    role,
    ...targetArgs(target),
  });
}

/** One live invite for a drive, as the server lists it. */
export interface DriveInviteInfo {
  /**
   * The blake3 hash of the token, never the token. The server cannot hand
   * back a link, which is why revoking by id is the only way to kill an
   * invite whose link the caller no longer holds.
   */
  inviteId: string;
  role: string;
  /**
   * Who minted it — the owner, or a manager they delegated to. Empty for
   * invites the server has no provenance for.
   */
  mintedBy: string;
  /** Minter display name (hcfs #455); absent when unknown. */
  mintedByName?: string;
  expiresAt: string;
  maxUses: number;
  useCount: number;
  revoked: boolean;
  valid: boolean;
  createdAt: string;
  /**
   * Full invite URL when Rust opened the row's sealed token under the drive
   * key. Treat as a drive-access capability: copy for the user, never log.
   * Absent when there is no blob, the invite is dead, or open failed.
   */
  inviteUrl?: string;
  /**
   * True when the listing carried a sealed blob for a still-valid invite.
   * The Links tab shows the link field; `inviteUrl` fills it or the locked
   * stand-in when absent.
   */
  linkAvailable?: boolean;
  /**
   * Folder of a folder invite; absent for a whole-drive invite. The Links
   * tab must show it, or a folder invite reads as access to everything.
   */
  pathPrefix?: string;
  /** Where a MAILED invitation was sent; absent on a link invite. */
  recipientEmail?: string;
  /**
   * How far a mailed invitation has got. `sent`: waiting for the recipient to
   * open it. `awaiting_seal`: opened, waiting for an owner or manager to
   * approve. `sealed`: approved, waiting for them to join. Absent on a link.
   */
  emailStatus?: EmailInviteStatus;
  /** The account that claimed a mailed invitation, once it was opened. */
  requesterSs58?: string;
}

export type EmailInviteStatus = "sent" | "awaiting_seal" | "sealed";

/** The live invites for an OWN drive. */
export async function listDriveInvites(
  label: string,
  target?: DriveTarget,
): Promise<DriveInviteInfo[]> {
  return invoke<DriveInviteInfo[]>("list_drive_invites", {
    label,
    ...targetArgs(target),
  });
}

/**
 * What one drive row needs to know about its own sharing, folded in Rust.
 * See `shared_drives/commands.rs::fold_drive_sharing` for the rule.
 */
export interface DriveSharingSummary {
  label: string;
  /** People who have joined. */
  memberCount: number;
  /** Invite links that can still admit someone. */
  liveInviteCount: number;
  /** Every invite the server still lists, expired and revoked included. */
  totalInviteCount: number;
}

/**
 * Sharing state for every OWN drive in `labels`, in one round-trip.
 *
 * A drive whose listings both failed is ABSENT from the result rather than
 * failing the call, and a label that is not an own drive is skipped; the
 * caller treats absence as "unknown", never as "not shared".
 */
export async function listOwnedDriveSharing(
  labels: readonly string[],
): Promise<DriveSharingSummary[]> {
  return invoke<DriveSharingSummary[]>("list_owned_drive_sharing", {
    labels: [...labels],
  });
}

/**
 * Revoke one invite for an OWN drive.
 *
 * Succeeds on a 404 as well: malformed, unknown, another drive's and
 * already-revoked ids all answer the same plain 404, so a failure is never
 * proof the invite existed — and "gone" is the state the caller asked for
 * either way.
 */
export async function revokeDriveInvite(
  label: string,
  inviteId: string,
  target?: DriveTarget,
): Promise<void> {
  await invoke<void>("revoke_drive_invite", {
    label,
    inviteId,
    ...targetArgs(target),
  });
}

/**
 * Size, file count and last-changed for one drive shared with this account.
 *
 * A drive whose owner's listing did not come back is ABSENT from the result,
 * never present with zeroes — an unknown size is not a zero, and a row that
 * renders one as "0 B" claims a drive is empty when nobody asked successfully.
 */
export interface SharedDriveStats {
  ownerSs58: string;
  folderHash: string;
  fileCount: number;
  totalBytes: number;
  /** Server-side last-change time, Unix SECONDS. */
  updatedAt: number;
}

/**
 * Stats for the drives shared with this account, by owner.
 *
 * The membership listing carries no counts, so only the owner's folder
 * listing has them. One request per distinct owner, not per drive.
 */
export async function listSharedDriveStats(
  owners: readonly string[],
): Promise<SharedDriveStats[]> {
  return invoke<SharedDriveStats[]>("list_shared_drive_stats", {
    owners: [...owners],
  });
}

/** List the drives shared WITH this account. */
export async function listMyDriveMemberships(): Promise<DriveMembershipInfo[]> {
  return invoke<DriveMembershipInfo[]>("list_my_drive_memberships");
}

/**
 * Leave a shared drive: delete this account's membership server-side, then
 * remove the local member drive (files on disk stay, like removing an own
 * drive). Fails whole with `SHARED_DRIVES_UNAVAILABLE` on a feature-off
 * server — the caller's escape hatch is the plain remove flow
 * (`removeSyncPath`), offered deliberately by the surface rather than
 * guessed at here.
 */
export async function leaveSharedDrive(label: string): Promise<void> {
  await invoke<void>("leave_shared_drive", { label });
}

/**
 * Leave a shared drive named by its WIRE identity.
 *
 * The label-keyed {@link leaveSharedDrive} resolves a local `sync_paths` row,
 * which a drive browsed but never synced here does not have. Membership is
 * server-side and does not depend on a local copy, so this works either way
 * and removes the local drive too when one exists.
 */
export async function leaveSharedDriveByIdentity(
  ownerSs58: string,
  folderHash: string,
): Promise<void> {
  await invoke<void>("leave_shared_drive_by_identity", { ownerSs58, folderHash });
}

/**
 * Sync a drive that was shared with this account into `localPath`.
 * Idempotent per wire identity: a re-add repairs the existing local slot,
 * and a healthy install at a different path refuses as `Validation` naming
 * the existing label/path — surface that message verbatim.
 */
export async function addSharedDrive(
  ownerSs58: string,
  folderHash: string,
  localPath: string,
  displayLabel: string,
): Promise<AddSharedDriveResult> {
  return invoke<AddSharedDriveResult>("add_shared_drive", {
    ownerSs58,
    folderHash,
    localPath,
    displayLabel,
  });
}

/**
 * Structural match for the feature-off-server refusal. Surfaces that hit it
 * must hide or quietly degrade — never toast — because the server simply
 * has not rolled the feature out yet.
 */
export function isSharedDrivesUnavailable(error: unknown): boolean {
  return isNotReady(error, "SHARED_DRIVES_UNAVAILABLE");
}

/**
 * Structural match for the mint plan gate: the server refused to mint a
 * shared-drive invite because the owner's plan is not Plus/Max/Scale. Owners
 * hitting this get an upgrade prompt (never a generic auth toast); joining is
 * never gated, so only the mint path raises it.
 */
export function isSharedDrivesNotEntitled(error: unknown): boolean {
  return isNotReady(error, "SHARED_DRIVES_NOT_ENTITLED");
}

/**
 * Invite `email` into a drive and have the server send the invitation.
 *
 * Viewer or Editor only (a Manager invite has to be a link), single use,
 * between one hour and thirty days; Rust refuses anything else by name.
 * Returns only the new invite's id: the token exists only in the mail.
 */
export async function emailDriveInvite(
  label: string,
  email: string,
  opts?: {
    role?: Exclude<DriveRole, "manager">;
    expiresInSecs?: number;
    target?: DriveTarget;
  },
): Promise<{ inviteId: string }> {
  return invoke<{ inviteId: string }>("email_drive_invite", {
    label,
    email,
    role: opts?.role ?? null,
    expiresInSecs: opts?.expiresInSecs ?? null,
    ...targetArgs(opts?.target),
  });
}

/**
 * Whether this server can send invitations by email. Asked without sending
 * one; `false` hides the option rather than offering a control that fails.
 */
export async function emailInvitesAvailable(
  label: string,
  target?: DriveTarget,
): Promise<boolean> {
  return invoke<boolean>("email_invites_available", {
    label,
    ...targetArgs(target),
  });
}

/**
 * Approve a mailed invitation that is `awaiting_seal`: Rust re-reads the row,
 * seals the drive key to the recipient's published key and posts it.
 * `already_sealed` means somebody approved it first.
 */
export async function approveEmailInvite(
  label: string,
  inviteId: string,
  target?: DriveTarget,
): Promise<{ status: "sealed" | "already_sealed" }> {
  return invoke<{ status: "sealed" | "already_sealed" }>("approve_email_invite", {
    label,
    inviteId,
    ...targetArgs(target),
  });
}

/** The server has no mail service: hide "Invite by email", never toast it. */
export function isEmailInvitesUnavailable(error: unknown): boolean {
  return isNotReady(error, "EMAIL_INVITES_UNAVAILABLE");
}
