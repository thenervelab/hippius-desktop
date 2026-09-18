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
  folderHash: string;
  displayLabel: string;
  role: string;
  /** RFC 3339 timestamp of when the membership was granted. */
  createdAt: string;
  syncedLocally: boolean;
  localLabel: string | null;
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
export async function createDriveInvite(
  label: string,
  opts?: { expiresInSecs?: number; maxUses?: number; role?: DriveRole },
): Promise<DriveInviteLink> {
  return invoke<DriveInviteLink>("create_drive_invite", {
    label,
    expiresInSecs: opts?.expiresInSecs,
    maxUses: opts?.maxUses,
    role: opts?.role,
  });
}

/** List the members of an OWN drive. */
export async function listDriveMembers(label: string): Promise<DriveMemberInfo[]> {
  return invoke<DriveMemberInfo[]>("list_drive_members", { label });
}

/**
 * Remove a member from an OWN drive (revocation of access — the member's
 * drive surfaces the revoked state on its next sync cycle).
 */
export async function removeDriveMember(
  label: string,
  memberSs58: string,
): Promise<void> {
  await invoke<void>("remove_drive_member", { label, memberSs58 });
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
): Promise<void> {
  await invoke<void>("change_drive_member_role", { label, memberSs58, role });
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
  expiresAt: string;
  maxUses: number;
  useCount: number;
  revoked: boolean;
  valid: boolean;
  createdAt: string;
}

/** The live invites for an OWN drive. */
export async function listDriveInvites(
  label: string,
): Promise<DriveInviteInfo[]> {
  return invoke<DriveInviteInfo[]>("list_drive_invites", { label });
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
): Promise<void> {
  await invoke<void>("revoke_drive_invite", { label, inviteId });
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
