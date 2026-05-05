// Typed wrappers around the Rust file-sharing IPC commands.
//
// The Rust source of truth lives at `src-tauri/src/shares/`.
// `hcfs_create_share`, `hcfs_list_shares`, `hcfs_revoke_share`, and
// `hcfs_get_capabilities` are the four commands; this file is the only
// place in the FE that talks to them, so swapping the wire shape is a
// one-file change.

import { invoke } from "@tauri-apps/api/core";

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

export async function createShare(folderLabel: string, relativePath: string): Promise<ShareLink> {
  return invoke<ShareLink>("hcfs_create_share", { folderLabel, relativePath });
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
