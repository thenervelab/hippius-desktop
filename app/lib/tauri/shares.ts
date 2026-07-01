// Typed wrappers around the Rust file-sharing IPC commands.
//
// The Rust source of truth lives at `src-tauri/src/shares/`.
// `hcfs_create_share`, `hcfs_list_shares`, `hcfs_revoke_share`, and
// `hcfs_get_capabilities` are the four commands; this file is the only
// place in the FE that talks to them, so swapping the wire shape is a
// one-file change.

import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Server feature advertisement. Old hcfs-server deployments either
 * 404 on `/v1/capabilities` or omit the `shares` field — both collapse
 * to `{ shares: false }` in the Rust layer so the FE never has to
 * special-case "the route is gone".
 */
export interface ServerCapabilities {
  shares: boolean;
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
  /** RFC 3339 timestamp. */
  expiresAt: string;
}

/**
 * Result of a confirmed Finder share, returned by {@link confirmFinderShare}. A
 * superset of {@link ShareLink}: a password-protected ("private") share also
 * carries the randomly generated `password` the recipient needs to open the
 * link. Absent (`undefined`) for a public share — the Rust side omits the field.
 */
export interface FinderShareCreated extends ShareLink {
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
  /** RFC 3339 timestamp. */
  expiresAt: string;
  /** Recipient URL with the `#k=<key>` fragment, or `null` if the key is unknown locally. */
  shareUrl: string | null;
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
  onProgress?: (progress: ShareProgress) => void,
): Promise<ShareLink> {
  const onProgressChannel = new Channel<ShareProgress>();
  if (onProgress) onProgressChannel.onmessage = onProgress;
  return invoke<ShareLink>("hcfs_create_share", {
    folderLabel,
    relativePath,
    onProgress: onProgressChannel,
  });
}

export async function listShares(): Promise<ShareSummary[]> {
  return invoke<ShareSummary[]>("hcfs_list_shares");
}

export async function revokeShare(shareToken: string): Promise<void> {
  await invoke<void>("hcfs_revoke_share", { shareToken });
}

/**
 * Revoke an existing share and immediately mint a fresh one for the
 * same source file. Effectively extends the TTL — hcfs-server has no
 * native "extend share" endpoint, so the desktop synthesises one out
 * of the existing primitives.
 *
 * Throws a `Validation` error from the Rust layer when this device
 * doesn't know which file the share came from (legacy share, different
 * device, wiped DB). The `/shares` page disables the Reshare button
 * for those rows up front so the user shouldn't reach that branch via
 * UI, but the IPC enforces the same invariant for direct callers.
 */
export async function reshare(shareToken: string): Promise<ShareLink> {
  return invoke<ShareLink>("hcfs_reshare", { shareToken });
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
  visibility: "public" | "private",
  onProgress?: (progress: ShareProgress) => void,
): Promise<FinderShareCreated> {
  const onProgressChannel = new Channel<ShareProgress>();
  if (onProgress) onProgressChannel.onmessage = onProgress;
  return invoke<FinderShareCreated>("hcfs_finder_confirm_share", {
    requestId,
    visibility,
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
