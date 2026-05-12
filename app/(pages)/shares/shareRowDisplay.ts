// History-row display helper for the /shares page.
//
// The active-list table reads `ShareSummary.filename` directly — the
// server returns plaintext filenames for every share (post hcfs PR
// #174 / 874585e), and the "this share was minted on another device"
// signal lives in `shareUrl === null`, surfaced as a badge next to
// the filename. No active-list helper is needed.
//
// History rows are different: they're snapshots stored in the local
// `shared_link_history` SQLite table, captured at the moment a share
// transitioned to revoked/expired. Pre-#174 captures on a device
// without the keystore entry stored `filename: null`. Those legacy
// rows still need a placeholder so the table renders something.
// Captures taken after this change always have a real filename.

const CONSOLE_ORIGIN_LABEL = "Created from the console";

export interface ShareRowDisplay {
  text: string;
  isPlaceholder: boolean;
}

/**
 * History-row filename → display tuple. The active table reads
 * `row.filename` directly (always real after hcfs 874585e); only
 * legacy history snapshots can carry `filename: null`, which renders
 * as the same console-origin placeholder the active list used to
 * show before the wire-format upgrade.
 */
export function pickHistoryRowDisplay(filename: string | null): ShareRowDisplay {
  if (filename === null) {
    return { text: CONSOLE_ORIGIN_LABEL, isPlaceholder: true };
  }
  return { text: filename, isPlaceholder: false };
}
