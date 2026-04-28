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
 * `shareUrl` is `null` when the keystore on this device has lost the
 * key for this token (different device, wiped DB). In that case
 * `filename` will also be `"<unknown>"` because hcfs-client decrypts
 * filenames with the same keystore lookup. The row is still useful —
 * the user can revoke it.
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
