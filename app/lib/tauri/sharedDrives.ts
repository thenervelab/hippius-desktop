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
  /** The server's id for the new invite, so it can be revoked right away. */
  inviteId: string;
  /**
   * What was actually sent, after Rust applied its defaults and the folder
   * caps. The Share dialog describes the new link from these, so
   * it never quotes a lifetime or a uses count the server was not asked for.
   */
  role: DriveRole;
  expiresInSecs: number;
  /** Always 1 for a folder link. */
  maxUses: number;
}

/** One row of the owner-side members table. */
export interface DriveMemberInfo {
  memberSs58: string;
  role: string;
  /** RFC 3339 timestamp of when the member joined. */
  createdAt: string;
  /** Display name (hcfs #455); absent when unknown. */
  memberName?: string;
  /** Email, only disclosed to the drive's owner. */
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
 * Which drive an access call addresses when there is no local label.
 *
 * A member may hold a drive they never synced here; the label-keyed path
 * resolves a `sync_paths` row such a drive does not have, and the lenient
 * fallback then answers with THIS account's namespace. Naming the wire
 * identity is how the reads (who has access, the panel) address the right
 * drive. Every access change on such a drive is refused in Rust: only the
 * owner invites and removes people.
 */
export interface DriveTarget {
  ownerSs58?: string | null;
  folderHash?: string | null;
}

/** The identity args every access IPC accepts, normalised to nulls. */
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
  },
): Promise<DriveInviteLink> {
  return invoke<DriveInviteLink>("create_drive_invite", {
    label,
    expiresInSecs: opts?.expiresInSecs,
    maxUses: opts?.maxUses,
    role: opts?.role,
    ...targetArgs(opts?.target),
  });
}

/**
 * Mint a FOLDER invite link: one person, one folder, at most 30 days. A
 * separate command from {@link createDriveInvite} on purpose: the folder is
 * required, and Rust refuses an empty one before anything is sent, so sharing
 * a folder can never come back as a whole-drive invite.
 *
 * Refusals to match (structured, never by message): the folder coming-soon
 * kinds ({@link isFolderInvitesUnavailable},
 * {@link isFolderEditorInvitesUnavailable}) and the plan gate
 * ({@link isSharedDrivesNotEntitled}).
 */
export async function createFolderInvite(
  label: string,
  pathPrefix: string,
  opts?: {
    expiresInSecs?: number;
    role?: DriveRole;
    target?: DriveTarget;
  },
): Promise<DriveInviteLink> {
  return invoke<DriveInviteLink>("create_folder_invite", {
    label,
    pathPrefix,
    expiresInSecs: opts?.expiresInSecs,
    role: opts?.role,
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

/** A whole-drive member, as the Share dialog lists them. */
export interface ShareAccessMember {
  memberSs58: string;
  role: string;
  memberName?: string;
  memberEmail?: string;
  /** This account: its own role is never changed from here. */
  isYou: boolean;
}

/** Someone holding a grant on the shared folder, or on a folder around it. */
export interface ShareAccessHolder {
  memberSs58: string;
  /** `reader` or `writer`. */
  role: string;
  /** The grant's folder: the shared one, or a folder it sits inside. */
  pathPrefix: string;
  memberName?: string;
  memberEmail?: string;
  /** Other folders on the drive they hold; removing them removes those too. */
  otherFolderCount: number;
}

/**
 * Everyone with access to a drive or one folder of it, folded in Rust
 * (`list_share_access`): who owns it, who is in it, and the emailed
 * invitations still waiting for this drive or folder.
 */
export interface ShareAccess {
  ownerSs58: string;
  ownerIsYou: boolean;
  /** Whole-drive members; empty for a folder. */
  members: ShareAccessMember[];
  /** Folder holders; empty for a drive. */
  folderHolders: ShareAccessHolder[];
  /** Live emailed invitations for exactly this drive or folder. */
  pendingInvites: DriveInviteInfo[];
  /** People with whole-drive access (they can open any folder too). */
  driveMemberCount: number;
}

/**
 * Who has access, for the Share dialog. `pathPrefix` present (even empty)
 * means a folder; Rust refuses an empty one rather than list the drive.
 */
export async function listShareAccess(
  label: string,
  pathPrefix: string | null,
  target?: DriveTarget,
): Promise<ShareAccess> {
  return invoke<ShareAccess>("list_share_access", {
    label,
    pathPrefix,
    ...targetArgs(target),
  });
}

/** A whole-drive member in the Manage access panel. */
export interface AccessPanelMember extends ShareAccessMember {
  /** RFC 3339 join time. */
  createdAt: string;
}

/** A folder holder in the Manage access panel, with every folder they hold. */
export interface AccessPanelHolder {
  memberSs58: string;
  memberName?: string;
  memberEmail?: string;
  isYou: boolean;
  /** `reader` or `writer`, of the grant named by `pathPrefix`. */
  role: string;
  /** The folder the row is tagged with (see `access_panel.rs`). */
  pathPrefix: string;
  /** Every folder they hold on this drive, sorted. */
  folders: string[];
}

/** An emailed invitation still waiting, as the panel lists it. */
export interface AccessPanelInvite extends DriveInviteInfo {
  /** Seconds until it expires, counted in Rust; null for an unreadable date. */
  expiresInSecs: number | null;
}

/** Why a link does or does not work, decided in Rust. */
export type AccessPanelLinkStatus = "active" | "revoked" | "expired" | "used_up";

/** One link invite in the panel. */
export interface AccessPanelLink {
  inviteId: string;
  role: string;
  /** The folder of a folder link; absent for a whole-drive link. */
  pathPrefix?: string;
  /** Who made it; empty when the server has no provenance for it. */
  mintedBy: string;
  mintedByName?: string;
  mintedByYou: boolean;
  useCount: number;
  maxUses: number;
  singleUse: boolean;
  /** 0 to 100. */
  usagePercent: number;
  status: AccessPanelLinkStatus;
  expiresAt: string;
  neverExpires: boolean;
  /** Seconds left on an active, expiring link; null otherwise. */
  expiresInSecs: number | null;
  /**
   * The full link when it opened here. A drive-access capability: copy it,
   * never show the part after `#`, never log it.
   */
  inviteUrl?: string;
  /** A sealed copy exists, so the row has a link field. */
  linkAvailable: boolean;
}

/**
 * Everything the Manage access panel shows, folded in Rust
 * (`list_access_panel`, `shared_drives/access_panel.rs`).
 */
export interface AccessPanel {
  ownerSs58: string;
  ownerIsYou: boolean;
  /** `owner`, a member role, or a folder grant role; null when unknown. */
  yourRole: string | null;
  /** The owner only; everyone else reads the panel. */
  canManage: boolean;
  /** Whole-drive members, you first. A folder panel lists them too. */
  members: AccessPanelMember[];
  folderHolders: AccessPanelHolder[];
  pendingInvites: AccessPanelInvite[];
  /** Links that still work. */
  links: AccessPanelLink[];
  /** Links that no longer work: expired, used up or revoked. */
  inactiveLinks: AccessPanelLink[];
  /** Working links exist that only the unlock password can show. */
  linksLocked: boolean;
  driveMemberCount: number;
}

/**
 * The Manage access panel's data for a drive, or for one folder of it when
 * `pathPrefix` is present.
 */
export async function listAccessPanel(
  label: string,
  pathPrefix: string | null,
  target?: DriveTarget,
): Promise<AccessPanel> {
  return invoke<AccessPanel>("list_access_panel", {
    label,
    pathPrefix,
    ...targetArgs(target),
  });
}

/** One folder grant on a drive, as its owner sees it. */
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

/** A holder's folders after a replace, as the server stored them. */
export interface ReplacedFolderGrants {
  memberSs58: string;
  pathPrefixes: string[];
  /** The stored role for each entry of `pathPrefixes`, same order. */
  roles: string[];
}

/**
 * Replace the folders a grant holder may reach: add folders or narrow to
 * fewer. `role` applies only to folders this call ADDS (Viewer when omitted);
 * a folder they already hold keeps its role. Removing every grant is
 * {@link removeDriveMember} instead.
 *
 * Refusals to match (structured): {@link isFolderEditorInvitesUnavailable}
 * for an Editor folder while the server has writer grants off, and
 * {@link isFolderInvitesUnavailable} when folder grants are off.
 */
export async function replaceFolderGrants(
  label: string,
  memberSs58: string,
  pathPrefixes: string[],
  opts?: {
    role?: DriveRole;
    target?: DriveTarget;
  },
): Promise<ReplacedFolderGrants> {
  return invoke<ReplacedFolderGrants>("replace_folder_grants", {
    label,
    memberSs58,
    pathPrefixes,
    role: opts?.role ?? null,
    ...targetArgs(opts?.target),
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
 * Change a member's role on an OWN drive: Viewer or Editor.
 *
 * The new role binds on the member's very next request, so nothing here has
 * to warn about propagation. Refusals come back as `Validation` and are
 * worth surfacing verbatim: targeting yourself (a member leaves instead), a
 * role other than Viewer or Editor, and a drive this account does not own.
 *
 * A downward change is sticky: the server revokes the invite that admitted
 * the member when that link still outranks the new role.
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
   * Who minted it: the owner, or (for an older link) a member the server
   * once let invite. Empty for invites the server has no provenance for.
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
   * open it. `awaiting_seal`: opened, waiting for the owner to
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
  /** Whole-drive members. Folder holders are the folder's, not the drive's. */
  memberCount: number;
  /** Whole-drive invite links that can still admit someone. */
  liveInviteCount: number;
  /** Every whole-drive invite the server still lists, lapsed ones included. */
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
 * One folder of an own drive that is shared on its own. See
 * `shared_drives/commands.rs::fold_folder_sharing` for the rule.
 */
export interface FolderSharingSummary {
  /** Drive-relative folder, no surrounding `/`, NFC. */
  path: string;
  /** People holding a grant on exactly this folder. */
  holderCount: number;
  /** A folder invite for exactly this folder is listed, live or spent. */
  hasInvite: boolean;
}

/**
 * The folders of ONE own drive that are shared on their own. Asked only for
 * the drive being browsed, never fanned out over the drive list.
 */
export async function listOwnedFolderSharing(
  label: string,
): Promise<FolderSharingSummary[]> {
  return invoke<FolderSharingSummary[]>("list_owned_folder_sharing", { label });
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
 * Viewer or Editor only, single use,
 * between one hour and thirty days; Rust refuses anything else by name.
 * Returns only the new invite's id: the token exists only in the mail.
 */
export async function emailDriveInvite(
  label: string,
  email: string,
  opts?: {
    role?: DriveRole;
    expiresInSecs?: number;
    target?: DriveTarget;
    /**
     * A folder to invite into. The server refuses to mail a folder invite
     * for now, which comes back as {@link isFolderEmailInvitesUnavailable}.
     */
    pathPrefix?: string;
  },
): Promise<{ inviteId: string }> {
  return invoke<{ inviteId: string }>("email_drive_invite", {
    label,
    email,
    role: opts?.role ?? null,
    expiresInSecs: opts?.expiresInSecs ?? null,
    pathPrefix: opts?.pathPrefix ?? null,
    ...targetArgs(opts?.target),
  });
}

/**
 * Whether this server can send invitations by email, asked without sending
 * one. A HINT only: the option is always offered, and `false` lets the dialog
 * say "coming soon" before the user types an address.
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

/**
 * Emitted by Rust each time it delivers an emailed invitation's key on its
 * own (`shared_drives::auto_seal`), so the owner never had to press Approve.
 */
export const INVITE_KEY_DELIVERED_EVENT = "shared-drive:invite-key-delivered";

/** Payload of {@link INVITE_KEY_DELIVERED_EVENT}. */
export interface InviteKeyDelivered {
  /** The drive's label, which is its name. */
  label: string;
  folderHash: string;
  inviteId: string;
  /** Absent when the address is hidden (a placeholder address). */
  recipientEmail?: string;
  /** Present for a folder invitation. */
  pathPrefix?: string;
}

/**
 * Start delivering emailed invitation keys in the background while this
 * account is signed in. Rust decides everything else (owner only, never
 * prompts, plan gate, cadence); `folderInvites` is whether folder
 * collaboration is on, the flag that shows a folder invitation's Approve.
 */
export async function startInviteAutoSeal(folderInvites: boolean): Promise<void> {
  await invoke("start_invite_auto_seal", { folderInvites });
}

/** Stop the background delivery. Sign-out stops it in Rust as well. */
export async function stopInviteAutoSeal(): Promise<void> {
  await invoke("stop_invite_auto_seal");
}

/** Ask the background delivery to look again now. */
export async function nudgeInviteAutoSeal(): Promise<void> {
  await invoke("nudge_invite_auto_seal");
}

/** Rust's as-you-type verdict on an invite address. */
export interface InviteEmailCheck {
  /** Whether "Send invite" may be pressed. */
  valid: boolean;
  /** What to say under the field; absent while it is empty or valid. */
  message?: string;
}

/**
 * Check a typed invite address with the same rule the send applies
 * (`validate_invite_email` in Rust). No network call, so the dialog can ask
 * on every change.
 */
export async function checkInviteEmail(email: string): Promise<InviteEmailCheck> {
  return invoke<InviteEmailCheck>("check_invite_email", { email });
}

/** The server has no mail service: say email invites are coming soon. */
export function isEmailInvitesUnavailable(error: unknown): boolean {
  return isNotReady(error, "EMAIL_INVITES_UNAVAILABLE");
}

/** Folder invites are off on this server: sharing one folder is coming soon. */
export function isFolderInvitesUnavailable(error: unknown): boolean {
  return isNotReady(error, "FOLDER_INVITES_UNAVAILABLE");
}

/** Editor folder invites are off: Editor on one folder is coming soon. */
export function isFolderEditorInvitesUnavailable(error: unknown): boolean {
  return isNotReady(error, "FOLDER_EDITOR_INVITES_UNAVAILABLE");
}

/** A folder invite cannot be mailed yet: email for one folder is coming soon. */
export function isFolderEmailInvitesUnavailable(error: unknown): boolean {
  return isNotReady(error, "FOLDER_EMAIL_INVITES_UNAVAILABLE");
}

/** One folder shared WITH this account (a folder grant it holds). */
export interface MyFolderGrantInfo {
  ownerSs58: string;
  ownerName?: string;
  folderHash: string;
  /** The drive the folder belongs to, as its owner named it. */
  displayLabel: string;
  /** The granted folder, drive-relative. */
  pathPrefix: string;
  /** `reader` (Viewer) or `writer` (Editor); anything else reads as Viewer. */
  role: string;
  createdAt: string;
  /**
   * Whether this account may change files in the folder, decided in Rust:
   * an Editor grant, writer grants on at the server, and not frozen.
   */
  canWrite: boolean;
  frozen?: boolean;
  frozenUntil?: string;
}

/**
 * The folders shared WITH this account, apart from whole-drive memberships so
 * a grant is never mistaken for the drive. Empty on a server without folder
 * grants.
 */
export async function listMyFolderGrants(): Promise<MyFolderGrantInfo[]> {
  return invoke<MyFolderGrantInfo[]>("list_my_folder_grants");
}
