// History-row display helper for the /shares page.
//
// The active-list table reads `ShareSummary.filename` directly — the
// server returns plaintext filenames for every share, and the "this
// share was minted on another device" signal lives in
// `shareUrl === null`, surfaced as a badge next to the filename. No
// active-list helper is needed.
//
// History rows are different: they're snapshots stored in the local
// `shared_link_history` SQLite table, captured at the moment a share
// transitioned to revoked/expired. Older captures on a device without
// the keystore entry stored `filename: null`. Those rows still need a
// placeholder so the table renders something; current captures always
// carry a real filename.

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
