// Typed wrappers around the share-history IPCs added in
// `src-tauri/src/shares/commands.rs`. Per-device history of expired
// and revoked links — see the design doc for the capture model.
//
// The Rust `HistoryEntry` is serialized with `#[serde(rename_all = "camelCase")]`
// so the wire shape matches `ShareHistoryEntry` 1:1. Optional fields mirror
// `Option<…>` on the Rust side: they are `null` when this device never
// learned the value (e.g. a row carried over from a different device, or
// minted before the `share_origin` sidecar existed).

import { invoke } from "@tauri-apps/api/core";

/**
 * How a share left the active list, captured at the moment of removal.
 *
 * - `expired` — server-side TTL elapsed before any revoke happened. The
 *   diff path infers this from `expiresAt <= now` when a row drops out.
 * - `revoked_here` — the user pressed Revoke on this device. The
 *   `hcfs_revoke_share` command records it directly; the diff path
 *   would otherwise mis-classify the same drop-out as "elsewhere".
 * - `revoked_elsewhere` — row dropped out of the active list while still
 *   in-date, so a different device must have revoked it.
 */
export type HistoryEndReason = "expired" | "revoked_here" | "revoked_elsewhere";

/**
 * One row of share history. `filename`, `folderLabel`, `relativePath`,
 * `plaintextSize`, and `mimeType` are `null` when this device didn't
 * have the keystore entry / origin sidecar at the time the row was
 * captured. The UI renders the cross-device placeholder when
 * `filename` is `null`.
 */
export interface ShareHistoryEntry {
  shareToken: string;
  filename: string | null;
  folderLabel: string | null;
  relativePath: string | null;
  plaintextSize: number | null;
  mimeType: string | null;
  /** RFC 3339 timestamp. */
  createdAt: string;
  /** RFC 3339 timestamp. */
  expiresAt: string;
  /** RFC 3339 timestamp the row left the active list. */
  endedAt: string;
  endReason: HistoryEndReason;
}

export async function listShareHistory(): Promise<ShareHistoryEntry[]> {
  return invoke<ShareHistoryEntry[]>("hcfs_list_share_history");
}

export async function removeShareHistory(shareToken: string): Promise<void> {
  await invoke<void>("hcfs_remove_share_history", { shareToken });
}

export async function clearShareHistory(): Promise<void> {
  await invoke<void>("hcfs_clear_share_history");
}
