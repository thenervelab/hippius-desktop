// Which share links belong to which file: the one rule every surface that
// shows a file's link uses (the Drive and Captures rows, Overview's Recent
// Files, the tray popover's rows, the Insights sheet), so a link icon, a row's
// Insights and its Copy link can never disagree. Rust's
// `shares::quick_link::link_belongs_to_file` is the same rule for the Copy
// link and Create link commands; the two are pinned by matching tests.
//
// Pure, with no React and no providers, because the tray popover is a
// provider-free webview and reads the share listing with a raw `invoke`.

import type { ShareSummary } from "@/app/lib/tauri/shares";
import { getFileTypeFromExtension } from "@/app/lib/utils/getTileTypeFromExtension";

/** The share listing, indexed for O(1) per-row lookups. */
export interface ShareLinkIndex {
  /** Links this device made, by drive label then drive-relative path. */
  byPath: Map<string, Map<string, ShareSummary[]>>;
  /** Links this device has no origin for, by `filename`. */
  unplacedByName: Map<string, ShareSummary[]>;
}

/** The two lookups the matching rule needs. */
export interface ShareLinkLookups {
  /** Links this device made for `(label, relativePath)`. */
  getSharesFor: (label: string | null | undefined, relativePath: string | null | undefined) => ShareSummary[];
  /**
   * Links made from a file of this name that this device has no origin for:
   * made in the browser extension, the web console or on another computer
   * (`share_origin` is per device).
   */
  getUnplacedSharesNamed: (fileName: string | null | undefined) => ShareSummary[];
}

export const EMPTY_SHARE_INDEX: ShareLinkIndex = { byPath: new Map(), unplacedByName: new Map() };
const EMPTY_ROWS: ShareSummary[] = [];

function pushTo(map: Map<string, ShareSummary[]>, key: string, row: ShareSummary) {
  const list = map.get(key);
  if (list) list.push(row);
  else map.set(key, [row]);
}

/** Index the share listing (`hcfs_list_shares`). */
export function buildShareIndex(rows: ShareSummary[]): ShareLinkIndex {
  const index: ShareLinkIndex = { byPath: new Map(), unplacedByName: new Map() };
  for (const row of rows) {
    if (!row.folderLabel || !row.relativePath) {
      if (row.filename) pushTo(index.unplacedByName, row.filename, row);
      continue;
    }
    let folder = index.byPath.get(row.folderLabel);
    if (!folder) {
      folder = new Map();
      index.byPath.set(row.folderLabel, folder);
    }
    pushTo(folder, row.relativePath, row);
  }
  return index;
}

/** The lookups over one index. */
export function shareLookups(index: ShareLinkIndex): ShareLinkLookups {
  return {
    getSharesFor: (label, relativePath) => {
      if (!label || !relativePath) return EMPTY_ROWS;
      return index.byPath.get(label)?.get(relativePath) ?? EMPTY_ROWS;
    },
    getUnplacedSharesNamed: (fileName) => (fileName && index.unplacedByName.get(fileName)) || EMPTY_ROWS,
  };
}

/**
 * The newest of a file's links: the one its Insights are about, and the one
 * its Copy link copies. Takes folder links too (anything with `createdAt`).
 */
export function newestShare<T extends Pick<ShareSummary, "createdAt">>(rows: readonly T[]): T | null {
  let newest: T | null = null;
  for (const row of rows) {
    if (!newest || Date.parse(row.createdAt) > Date.parse(newest.createdAt)) newest = row;
  }
  return newest;
}

/** A screenshot or a recording: the files Insights are offered for. */
export function isCaptureMedia(name: string | null | undefined): boolean {
  const dot = name?.lastIndexOf(".") ?? -1;
  if (!name || dot < 0) return false;
  const type = getFileTypeFromExtension(name.slice(dot + 1));
  return type === "image" || type === "video";
}

/**
 * A name Hippius gives a capture: "Screenshot " or "Recording ", then
 * `YYYY-MM-DD at HH.MM.SS`, then anything (an extension, " (edited)"). The
 * same rule as Rust's `shares::preview::is_capture_name`. Only such a name,
 * which carries the second it was taken, is specific enough to match a link
 * made elsewhere by name alone: a plain `image.png` is not.
 */
export function isCaptureName(name: string): boolean {
  return /^(Screenshot|Recording) \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}/.test(name);
}

/** The last part of a drive-relative path. */
function baseName(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

/**
 * A file's links: the ones this device made for its path, and, for a
 * capture, the ones made elsewhere (the browser extension, the web console,
 * another computer) from a file of the same name, unless the sizes say it was
 * a different file. The server names a link's file by name and size only, and
 * the console and the extension match links to files the same way. Trusted
 * only for a capture's own name ({@link isCaptureName}), which carries the
 * second it was taken; any other file, a plain `image.png` included, gets
 * only this device's links.
 */
export function captureSharesFrom(
  lookups: ShareLinkLookups,
  label: string | null | undefined,
  relativePath: string | null | undefined,
  size?: number,
): ShareSummary[] {
  if (!label || !relativePath) return [];
  const placed = lookups.getSharesFor(label, relativePath);
  const name = baseName(relativePath);
  if (!isCaptureMedia(relativePath) || !isCaptureName(name)) return placed;
  const named = lookups
    .getUnplacedSharesNamed(name)
    .filter((row) => !size || !row.plaintextSize || row.plaintextSize === size);
  return named.length === 0 ? placed : [...placed, ...named];
}
