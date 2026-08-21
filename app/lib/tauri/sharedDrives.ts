// Typed wrappers around the Rust shared-drive IPC commands.
//
// The Rust source of truth lives at `src-tauri/src/shared_drives/`.
// `create_drive_invite`, `list_drive_members`, `remove_drive_member`,
// `list_my_drive_memberships`, `leave_shared_drive`, and `add_shared_drive`
// are the six commands; this file is the only place in the FE that talks to
// them (the `shares.ts` convention), so swapping the wire shape is a
// one-file change.
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
 * Default invite lifetime (7 days) and claim cap (50 uses) — v1 mints with
 * these unless the modal's expiry preset picks another lifetime. The cap is
 * a blast-radius bound on a leaked link, not a UI concept, so it is not
 * user-configurable.
 */
export const DEFAULT_INVITE_TTL_SECS = 7 * 24 * 60 * 60;
export const DEFAULT_INVITE_MAX_USES = 50;

/**
 * Mint an invite link for an OWN drive. `label` is the local drive label;
 * the backend refuses a member drive's label as `Validation` (only the
 * owner can mint).
 */
export async function createDriveInvite(
  label: string,
  opts?: { expiresInSecs?: number; maxUses?: number },
): Promise<DriveInviteLink> {
  return invoke<DriveInviteLink>("create_drive_invite", {
    label,
    expiresInSecs: opts?.expiresInSecs ?? DEFAULT_INVITE_TTL_SECS,
    maxUses: opts?.maxUses ?? DEFAULT_INVITE_MAX_USES,
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
