// Returns what to render in a share row's filename slot, plus whether
// it's a placeholder (so the caller can apply italic styling).
//
// Cross-device shares — minted on a different device or after a local
// DB wipe — surface from Rust with `shareUrl: null` because the local
// keystore doesn't have the `#k=<key>` fragment. hcfs-client's filename
// decryption uses the same keystore lookup, so the filename also
// collapses to the marker `<unknown>`. The user can still revoke; the
// placeholder explains why Copy and Reshare are disabled.

import type { ShareSummary } from "@/app/lib/tauri/shares";

const CROSS_DEVICE_PLACEHOLDER = "Shared from another device";

export interface ShareRowDisplay {
  text: string;
  isPlaceholder: boolean;
}

export function pickShareRowDisplay(row: ShareSummary): ShareRowDisplay {
  if (row.shareUrl === null) {
    return { text: CROSS_DEVICE_PLACEHOLDER, isPlaceholder: true };
  }
  return { text: row.filename, isPlaceholder: false };
}
