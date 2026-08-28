// Typed wrappers around the Rust sharing IPC commands (file shares,
// browsable folder shares, and the capability probe).
//
// The Rust source of truth lives at `src-tauri/src/shares/`. This file is
// the only place in the FE that talks to those commands, so swapping the
// wire shape is a one-file change.

import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Server feature advertisement. Old hcfs-server deployments either
 * 404 on `/v1/capabilities` or omit the `shares` field — both collapse
 * to `{ shares: false }` in the Rust layer so the FE never has to
 * special-case "the route is gone".
 */
export interface ServerCapabilities {
  shares: boolean;
  /**
   * Browsable folder shares (`/v1/folder-shares`). Snake_case because the
   * Rust struct serializes its fields verbatim. Missing on old servers,
   * which the Rust layer collapses to `false`.
   */
  folder_shares: boolean;
}

/**
 * Returned by `hcfs_create_share`. `shareUrl` already includes the
 * `#k=<key>` fragment so the FE can hand it directly to the user; the
 * fragment is never transmitted to the server (browsers don't send
 * fragments on navigation).
 */
export interface ShareLink {
  shareToken: string;
  shareUrl: string;
  /** RFC 3339 timestamp, or `null` when the link never expires. */
  expiresAt: string | null;
  /**
   * Set only for a password-protected share, and only on the response that
   * created it. The password is never persisted, so this is the one and only
   * time the app can show it — the Shares page cannot recover it later, by
   * design. Absent for a public share.
   */
  password?: string;
}

/** How long a share link stays reachable. Matches the Rust/server presets. */
export type ShareTtl = "24h" | "7d" | "30d" | "never";

/** Whether the link is open to anyone holding it, or password-protected. */
export type ShareVisibility = "public" | "private";

/**
 * What the user chose in the share modal. `password` is only meaningful when
 * `visibility` is `"private"`; leaving it `undefined` there asks the backend to
 * generate one and return it on the {@link ShareLink}.
 */
export interface ShareChoice {
  ttl: ShareTtl;
  visibility: ShareVisibility;
  password?: string;
}

/**
 * Payload of the `finder:share-choosing` event, emitted the instant a "Share
 * with Hippius" right-click is received — before anything is minted. The app
 * opens its share chooser on `name`; the user picks public vs password and the
 * modal calls {@link confirmFinderShare} with the echoed `id`. Nothing is
 * uploaded until then (the public/private decision now lives in the app).
 */
export interface FinderShareChoosing {
  id: string;
  name: string;
}

/** Phase of an in-flight share creation. */
export type SharePhase = "encrypting" | "uploading" | "finalizing";

/**
 * Progress for an in-flight `hcfs_create_share`. The Rust backend binds
 * `tauri::ipc::Channel<ShareProgress>` directly to hcfs-client's
 * `ShareProgress`, which serializes to exactly this camelCase shape — so
 * the casing here is pinned cross-repo and must not drift from the
 * backend serde derive.
 *
 * `bytesDone`/`bytesTotal` count plaintext bytes during `encrypting` and
 * ciphertext bytes during `uploading`; the single-shot path (≤ 8 MiB)
 * reports phase edges only, so the bar may jump rather than ramp there.
 */
export interface ShareProgress {
  bytesDone: number;
  bytesTotal: number;
  phase: SharePhase;
}

/**
 * One row of the owner's "My Shares" list. The server only returns
 * currently-active shares (revoked rows are reaped before they could
 * surface here), so there is intentionally no `revokedAt` field.
 *
 * `filename` is always the real plaintext name returned by the server.
 * `shareUrl` is independent: it's `null` when the keystore on this
 * device has lost the key (different device, wiped DB) — in that case
 * the UI hides the Copy button but still offers Revoke and shows the
 * filename normally.
 */
export interface ShareSummary {
  shareToken: string;
  filename: string;
  plaintextSize: number;
  ciphertextSize: number;
  mimeType: string;
  /** RFC 3339 timestamp. */
  createdAt: string;
  /** RFC 3339 timestamp, or `null` when the link never expires. */
  expiresAt: string | null;
  /**
   * Recipient URL, or `null` if the key is unknown locally. Carries a `#k=`
   * fragment for a public share and a `#p=` one for a password-protected
   * share — the backend derives it from the stored secret's kind, so this can
   * never be a password-free link to a protected share.
   */
  shareUrl: string | null;
  /**
   * Whether this link is password-protected. Drives the lock badge and warns
   * that Copy hands out a link the recipient still needs a password for.
   * `false` when this device holds no key material for the row, which is also
   * when `shareUrl` is `null`.
   */
  isPrivate: boolean;
  /**
   * Drive label and relative path of the source file. `null` for legacy
   * shares created before the `share_origin` sidecar table existed and
   * for shares minted on a different device — both surface the same
   * way: no per-file badge, no Reshare button. Copy and Revoke still
   * work in either case.
   */
  folderLabel: string | null;
  relativePath: string | null;
}

export async function getServerCapabilities(accountId: string): Promise<ServerCapabilities> {
  return invoke<ServerCapabilities>("hcfs_get_capabilities", { accountId });
}

/**
 * Mint a share link for a synced file. When `onProgress` is supplied, each
 * backend `ShareProgress` is delivered to it while the share runs — the
 * share modal feeds these to its determinate bar.
 *
 * A `Channel` is always opened (even without `onProgress`) because the
 * Rust command param is a non-optional `Channel<ShareProgress>`; with no
 * callback its `onmessage` is just a no-op. Cleanup is backend-driven, not
 * promise-driven: `hcfs_create_share` owns the Rust `Channel` for the
 * duration of the call, so when the command returns and drops it, Tauri
 * sends an end-marker that unregisters this JS callback. There is no
 * lingering registration once the call completes.
 */
export async function createShare(
  folderLabel: string,
  relativePath: string,
  choice: ShareChoice,
  onProgress?: (progress: ShareProgress) => void,
): Promise<ShareLink> {
  const onProgressChannel = new Channel<ShareProgress>();
  if (onProgress) onProgressChannel.onmessage = onProgress;
  return invoke<ShareLink>("hcfs_create_share", {
    folderLabel,
    relativePath,
    ttl: choice.ttl,
    visibility: choice.visibility,
    password: choice.password ?? null,
    onProgress: onProgressChannel,
  });
}

/**
 * Mint a share link for a file that exists ONLY on the server (a row in a
 * browsable remote drive — `fileId` set, no local `source`). Console parity:
 * Rust downloads + decrypts the file to a temp path, streams it through the
 * same share pipeline as a local file, and removes the temp copy. Slower
 * than a local share (a full download precedes the upload), which is why it
 * is used only for remote rows.
 */
export async function createRemoteShare(
  folderLabel: string,
  relativePath: string,
  fileId: string,
  choice: ShareChoice,
  onProgress?: (progress: ShareProgress) => void,
): Promise<ShareLink> {
  const onProgressChannel = new Channel<ShareProgress>();
  if (onProgress) onProgressChannel.onmessage = onProgress;
  return invoke<ShareLink>("hcfs_create_remote_share", {
    folderLabel,
    relativePath,
    fileId,
    ttl: choice.ttl,
    visibility: choice.visibility,
    password: choice.password ?? null,
    onProgress: onProgressChannel,
  });
}

/**
 * Mint a live, browsable share link for a folder. One metadata POST — nothing
 * is packed or uploaded, so the call is instant regardless of folder size and
 * carries no progress channel. The link is live: later changes to the folder
 * appear in it.
 */
export async function createFolderShare(
  folderLabel: string,
  relativePath: string,
  choice: ShareChoice,
): Promise<ShareLink> {
  return invoke<ShareLink>("hcfs_create_folder_share", {
    folderLabel,
    relativePath,
    ttl: choice.ttl,
    visibility: choice.visibility,
    password: choice.password ?? null,
  });
}

export async function listShares(): Promise<ShareSummary[]> {
  return invoke<ShareSummary[]>("hcfs_list_shares");
}

/**
 * One row of the owner's folder-share listing.
 *
 * The server returns `tokenHash` (blake3 hex of the plaintext token) only —
 * folder-share tokens are never echoed after create. A row minted on THIS
 * machine resolves against the persistent keystore: `resolvable` is `true`,
 * `shareToken` carries the plaintext token (the handle
 * {@link revokeFolderShare} and {@link updateFolderShareExpiry} take), and
 * `shareUrl` is the rebuilt recipient link. A row minted on another device is
 * view-only: `resolvable` is `false` and both are `null`.
 *
 * Unlike {@link ShareSummary}, revoked and expired rows ARE present (with
 * `revokedAt` set / `expiresAt` in the past) until the server's reaper sweeps
 * them — render their dead state from the row. `folderHash` + `pathPrefix`
 * are the share's stable identity; the per-folder "Shared" badge keys on that
 * pair, never on the file-share origin sidecar.
 */
export interface FolderShareSummary {
  tokenHash: string;
  folderHash: string;
  /** `""` means the share covers the whole drive. */
  pathPrefix: string;
  displayName: string;
  /** RFC 3339 timestamp. */
  createdAt: string;
  /** RFC 3339 timestamp, or `null` when the link never expires. */
  expiresAt: string | null;
  /** RFC 3339 timestamp, set once the owner has revoked the share. */
  revokedAt: string | null;
  /** Whether this device's keystore holds the plaintext token. */
  resolvable: boolean;
  /** Plaintext token, present only for resolvable rows. */
  shareToken: string | null;
  /**
   * Recipient URL, or `null` for a foreign row. Carries `#k=` for a public
   * share and `#p=` for a password-protected one — the backend derives it
   * from the stored secret's kind, so this can never be a password-free link
   * to a protected share.
   */
  shareUrl: string | null;
  /**
   * Whether the link is password-protected. `null` for a foreign row: there
   * is no secret to inspect, so protection is UNKNOWN on this device —
   * `false` would label a password-protected share "public". `null`
   * coincides with `shareUrl` being `null`.
   */
  isPrivate: boolean | null;
}

/**
 * List every folder share this account has minted, newest first — including
 * revoked and not-yet-reaped expired rows in their dead state.
 */
export async function listFolderShares(): Promise<FolderShareSummary[]> {
  return invoke<FolderShareSummary[]>("hcfs_list_folder_shares");
}

/**
 * Revoke a folder share by its plaintext token (from a resolvable listing
 * row). Idempotent: an already-revoked or unknown token resolves rather than
 * rejecting, so a double-tapped Revoke needs no special-casing.
 */
export async function revokeFolderShare(shareToken: string): Promise<void> {
  await invoke<void>("hcfs_revoke_folder_share", { shareToken });
}

/**
 * Change an existing folder share's expiry, returning the new one (`null`
 * when the link now never expires). Only the expiry is mutable — same
 * contract as {@link updateShareExpiry}. Rejects with a `Validation` error
 * when the link is no longer active.
 */
export async function updateFolderShareExpiry(
  shareToken: string,
  ttl: ShareTtl,
): Promise<string | null> {
  return invoke<string | null>("hcfs_update_folder_share_expiry", { shareToken, ttl });
}

export async function revokeShare(shareToken: string): Promise<void> {
  await invoke<void>("hcfs_revoke_share", { shareToken });
}

/**
 * Change an existing link's expiry without re-uploading the file, returning
 * the new expiry (`null` when it now never expires).
 *
 * Only the expiry is mutable. A share's password is fixed when the link is
 * minted — the server holds no key material and this device does not persist a
 * private share's raw key — so handing out a different password means revoking
 * and re-sharing.
 *
 * Rejects with a `Validation` error when the link is no longer active
 * (revoked, already expired, or minted by another account).
 */
export async function updateShareExpiry(
  shareToken: string,
  ttl: ShareTtl,
): Promise<string | null> {
  return invoke<string | null>("hcfs_update_share_expiry", { shareToken, ttl });
}

/**
 * Confirm a Finder-initiated share with the visibility the user chose in the
 * app's chooser, then mint it. `requestId` is the `id` from the
 * `finder:share-choosing` event; the backend holds the resolved path, so the FE
 * never passes it. `onProgress` receives the encrypt/upload updates for the bar
 * (same `Channel` mechanics as {@link createShare}).
 *
 * Returns the link — and, for a `"private"` share, the generated `password`.
 * Rejects with a `NotFound` error if the request has expired (app restarted, or
 * confirmed twice); the modal surfaces that as "right-click again".
 */
export async function confirmFinderShare(
  requestId: string,
  choice: ShareChoice,
  onProgress?: (progress: ShareProgress) => void,
): Promise<ShareLink> {
  const onProgressChannel = new Channel<ShareProgress>();
  if (onProgress) onProgressChannel.onmessage = onProgress;
  return invoke<ShareLink>("hcfs_finder_confirm_share", {
    requestId,
    ttl: choice.ttl,
    visibility: choice.visibility,
    password: choice.password ?? null,
    onProgress: onProgressChannel,
  });
}

/**
 * Release a parked Finder share request when the user closes the chooser without
 * confirming, so an abandoned modal doesn't leak the pending entry. Idempotent:
 * an already-confirmed or expired `requestId` is a no-op on the backend.
 */
export async function cancelFinderShare(requestId: string): Promise<void> {
  await invoke<void>("hcfs_finder_cancel_share", { requestId });
}

/**
 * Ask the backend for a strong random share password.
 *
 * The share modal pre-fills its password field with this when the user picks
 * "Password protected", so the default path is strong without the user having
 * to invent one. Generating it in Rust (rather than in the browser) keeps one
 * CSPRNG and one alphabet behind every password the app produces.
 *
 * Purely a convenience: the user may overwrite it, and omitting the password
 * entirely still makes the backend generate one during the mint.
 */
export async function generateSharePassword(): Promise<string> {
  return invoke<string>("hcfs_generate_share_password");
}
