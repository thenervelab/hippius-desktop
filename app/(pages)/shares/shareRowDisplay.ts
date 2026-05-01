// Returns what to render in a share row's filename slot, plus whether
// it's a placeholder (so the caller can apply italic styling).
//
// Shares minted via the console (the web app's "Share with link"
// flow) surface from Rust with `shareUrl: null` because the local
// keystore doesn't have the `#k=<key>` fragment for them — the
// console keeps its own key copy. hcfs-client's filename decryption
// uses the same keystore lookup, so the filename also collapses to
// the marker `<unknown>`. The user can still revoke from this
// device; the placeholder explains why Copy and Reshare aren't
// available here.
//
// Project decision (2026-05-01): all "from elsewhere" shares are
// labelled as console-originated. We don't currently track origin
// server-side, so the assumption is workflow-driven — revisit if
// multi-desktop minting becomes a real use case.

import type { ShareSummary } from "@/app/lib/tauri/shares";

const CONSOLE_ORIGIN_LABEL = "Created from the console";

export interface ShareRowDisplay {
  text: string;
  isPlaceholder: boolean;
}

export function pickShareRowDisplay(row: ShareSummary): ShareRowDisplay {
  if (row.shareUrl === null) {
    return { text: CONSOLE_ORIGIN_LABEL, isPlaceholder: true };
  }
  return { text: row.filename, isPlaceholder: false };
}

/**
 * History-row sibling of `pickShareRowDisplay`. The active-list helper
 * keys on `shareUrl`, but history rows have no URL — by the time a row
 * lands in history the share is already revoked or expired, so the URL
 * is moot. The "is this from elsewhere?" signal collapses to whether
 * the filename was ever known on this device: a history row captured
 * by the diff path on a device that never had the keystore entry
 * stores `filename: null` (Rust `Option::None`).
 */
export function pickHistoryRowDisplay(filename: string | null): ShareRowDisplay {
  if (filename === null) {
    return { text: CONSOLE_ORIGIN_LABEL, isPlaceholder: true };
  }
  return { text: filename, isPlaceholder: false };
}
