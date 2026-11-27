// The "Paused" badge on a folder link Drive Trash keeps off, shared by the
// Shared Links table and the folder link's Insights panel. Rust reads the
// server's `paused` / `held` onto the listing row; this only words it.

import type { FolderShareSummary } from "@/app/lib/tauri/shares";

/** Badge on a folder link the server keeps off while its folder is in Trash. */
export const PAUSED_BADGE = "Paused";

/**
 * Why a paused link is off, in the console's words: in Trash for now, or
 * held for the owner to revoke because its folder left Trash another way.
 */
export function pausedTooltip(row: Pick<FolderShareSummary, "held">): string {
  return row.held === true
    ? "Off until you revoke it: its folder left Trash another way"
    : "Off while its folder is in Trash";
}

/**
 * Whether the row shows the Paused badge: only when the server said so, and
 * never over Revoked, which is final.
 */
export function isFolderLinkPaused(row: Pick<FolderShareSummary, "paused" | "held" | "revokedAt">): boolean {
  return row.revokedAt === null && (row.paused === true || row.held === true);
}
