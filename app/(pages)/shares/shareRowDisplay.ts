// Row-model helpers for the /shares page.
//
// FILE rows read `ShareSummary.filename` directly — the server returns
// plaintext filenames for every share, and the "minted on another device"
// signal lives in `shareUrl === null`.
//
// FOLDER rows come from the folder-share listing and differ in two ways
// that all the pure helpers below encode:
//   - dead rows (revoked / expired) ARE present until the server reaper
//     sweeps them, and must render their dead state — with Copy suppressed
//     even when the URL is locally resolvable;
//   - a row minted on another device is view-only (`resolvable: false`):
//     revoke and expiry need the plaintext token, which only the minting
//     device's keystore holds.
//
// History rows are different: they're snapshots stored in the local
// `shared_link_history` SQLite table, captured at the moment a FILE share
// transitioned to revoked/expired (folder shares are deliberately absent —
// their dead state lives on the listing row instead). Older captures on a
// device without the keystore entry stored `filename: null`. Those rows
// still need a placeholder so the table renders something; current captures
// always carry a real filename.

import type { FolderShareSummary, ShareSummary } from "@/app/lib/tauri/shares";

const CONSOLE_ORIGIN_LABEL = "Created from the console";

export interface ShareRowDisplay {
  text: string;
  isPlaceholder: boolean;
}

/**
 * History-row filename → display tuple. The active table reads
 * `row.filename` directly (always a real filename); only older
 * history snapshots can carry `filename: null`, which renders as a
 * console-origin placeholder.
 */
export function pickHistoryRowDisplay(filename: string | null): ShareRowDisplay {
  if (filename === null) {
    return { text: CONSOLE_ORIGIN_LABEL, isPlaceholder: true };
  }
  return { text: filename, isPlaceholder: false };
}

// =============================================================================
// Merged active-share rows (file + folder)
// =============================================================================

/** One row of the merged Active Shares table. */
export type ActiveShareRow =
  | { kind: "file"; file: ShareSummary }
  | { kind: "folder"; folder: FolderShareSummary };

/** Stable table row id: file tokens and folder token-hashes can't collide
 *  across the kind prefix, and a foreign folder row has no token at all. */
export function activeShareRowId(row: ActiveShareRow): string {
  return row.kind === "file"
    ? `file:${row.file.shareToken}`
    : `folder:${row.folder.tokenHash}`;
}

/**
 * Interleave file and folder shares into one newest-first list. Both inputs
 * already arrive newest-first from their listings; the merge re-sorts by
 * `createdAt` so a folder share minted between two file shares lands where
 * the user expects it.
 */
export function mergeActiveShareRows(
  files: ShareSummary[] | undefined,
  folders: FolderShareSummary[] | undefined,
): ActiveShareRow[] {
  const rows: ActiveShareRow[] = [
    ...(files ?? []).map((file) => ({ kind: "file", file }) as const),
    ...(folders ?? []).map((folder) => ({ kind: "folder", folder }) as const),
  ];
  return rows.sort((a, b) => {
    const createdA = Date.parse(a.kind === "file" ? a.file.createdAt : a.folder.createdAt);
    const createdB = Date.parse(b.kind === "file" ? b.file.createdAt : b.folder.createdAt);
    return (Number.isNaN(createdB) ? 0 : createdB) - (Number.isNaN(createdA) ? 0 : createdA);
  });
}

/** `""` shares the whole drive — render the console's idiom for it. */
export function folderSharePathLabel(pathPrefix: string): string {
  return pathPrefix === "" ? "Whole drive" : pathPrefix;
}

export type FolderShareRowState = "live" | "expired" | "revoked";

/** Revocation wins over expiry: a revoked link stays revoked forever. */
export function folderShareRowState(
  row: FolderShareSummary,
  now: number = Date.now(),
): FolderShareRowState {
  if (row.revokedAt !== null) return "revoked";
  if (row.expiresAt !== null) {
    const expiresMs = Date.parse(row.expiresAt);
    if (!Number.isNaN(expiresMs) && expiresMs <= now) return "expired";
  }
  return "live";
}

/** What a folder row's action menu may do, with honest tooltips for
 *  everything it may not. */
export interface FolderShareRowPlan {
  state: FolderShareRowState;
  /** Copy is live-and-resolvable only: a dead link must not be handed out
   *  even when this device could still rebuild its URL. */
  canCopy: boolean;
  copyTooltip?: string;
  /** Revoke needs the plaintext token; a revoked link has nothing left to
   *  revoke. An EXPIRED row stays revocable — the server's revoke collapses
   *  a beyond-saving row into the idempotent 404 path. */
  canRevoke: boolean;
  revokeTooltip?: string;
  /** Change-expiry is LIVE rows only: the server's PATCH 404s an expired
   *  row (the bodiless 404 covers revoked and expired alike), so offering
   *  the presets there could only ever end in an error toast. */
  canChangeExpiry: boolean;
  expiryTooltip?: string;
}

const FOREIGN_FOLDER_COPY_TOOLTIP =
  "The link can only be copied from the device that created it.";

// Console copy — the honest reason revoke/expiry are dead on a foreign row:
// both are keyed by the plaintext token, which only the minting device holds.
export const FOREIGN_FOLDER_REVOKE_TOOLTIP =
  "Created on another device — revoke it from the device where it was created";

export const FOREIGN_FOLDER_EXPIRY_TOOLTIP =
  "Created on another device — change its expiry from the device where it was created";

// Mirrors the backend's refusal wording: the server's PATCH 404s an expired
// row, so the presets could only end in an error toast.
export const EXPIRED_FOLDER_EXPIRY_TOOLTIP =
  "This link has expired, so its expiry can no longer be changed";

export function folderShareRowPlan(
  row: FolderShareSummary,
  now: number = Date.now(),
): FolderShareRowPlan {
  const state = folderShareRowState(row, now);
  const canRevoke = row.shareToken !== null && state !== "revoked";
  const canChangeExpiry = row.shareToken !== null && state === "live";

  const copyTooltip =
    state === "revoked"
      ? "This link has been revoked"
      : state === "expired"
        ? "This link has expired"
        : row.shareUrl === null
          ? FOREIGN_FOLDER_COPY_TOOLTIP
          : undefined;

  return {
    state,
    canCopy: state === "live" && row.shareUrl !== null,
    copyTooltip,
    canRevoke,
    revokeTooltip:
      canRevoke || state === "revoked" ? undefined : FOREIGN_FOLDER_REVOKE_TOOLTIP,
    canChangeExpiry,
    expiryTooltip: canChangeExpiry
      ? undefined
      : state === "expired"
        ? EXPIRED_FOLDER_EXPIRY_TOOLTIP
        : state === "revoked"
          ? undefined
          : FOREIGN_FOLDER_EXPIRY_TOOLTIP,
  };
}
