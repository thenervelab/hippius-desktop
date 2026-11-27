// Typed calls to Rust's Starred commands (`src-tauri/src/sync/fileops/favorites`).
// Rust owns the drive resolution, the server calls and every sentence; these
// only carry the arguments.

import { invoke } from "@tauri-apps/api/core";

/** What one star names: a file, a folder inside a drive, or a whole drive. */
export type StarKind = "file" | "folder" | "drive";

/**
 * One item to star or unstar, named the way the row on screen knows it.
 *
 * Rust resolves the drive (owner + folder hash) from `label`, or takes
 * `ownerSs58` + `folderHash` as given (the Starred page's own rows, which
 * carry them). Give both halves or neither.
 */
export interface StarTarget {
  kind: StarKind;
  /** The item's display name, for the error sentence. */
  name: string;
  /**
   * The label the row was listed under: a drive label, or a `shared:` /
   * `grant:` browse label. Ignored when `ownerSs58` + `folderHash` are given.
   */
  label?: string | null;
  ownerSs58?: string | null;
  folderHash?: string | null;
  /** A file: its 64-hex path hash (`fileId`, else `arionHash`). */
  fileId?: string | null;
  /**
   * A folder: its path relative to what `label` shows (the granted folder
   * for a `grant:` label, else the drive root). With an explicit identity,
   * relative to the drive root. Unused for a file or a drive.
   */
  path?: string | null;
}

/** The item's star after the call, under its key. */
export interface StarResult {
  key: string;
  favorite: boolean;
}

export interface StarFailure {
  name: string;
  /** `null` when the item could not even be resolved to a drive. */
  key: string | null;
  /** Rust's sentence, ready to show. */
  error: string;
}

export interface StarBatchResult {
  done: StarResult[];
  failed: StarFailure[];
  /** At least one item was refused because the account holds 1,000 stars. */
  full: boolean;
}

/**
 * What a drive label resolves to, for building a row's star key
 * ([`starKey`]). `rootPath` is the granted folder of a `grant:` label, else "".
 */
export interface StarScope {
  ownerSs58: string;
  folderHash: string;
  rootPath: string;
}

/** One starred item, with everything the Starred page needs to show and open it. */
export interface StarredItem {
  key: string;
  kind: StarKind;
  ownerSs58: string;
  folderHash: string;
  /** Drive label, folder name or file name. */
  name: string;
  /**
   * Drive-root relative path: "" for a drive, the folder's path, the file's
   * relative path ("" for a file the server holds no path for).
   */
  path: string;
  /** Files only: 64 lowercase hex. */
  fileId: string | null;
  /** Bytes: a drive's or folder's total, a file's size. */
  size: number | null;
  /** Unix seconds; `null` when the server has no date. */
  createdAt: number | null;
  /** Drives and folders: files inside. */
  fileCount: number | null;
  /** This account owns the drive the item is in. */
  isOwn: boolean;
  /** The drive's name (for someone else's drive, the owner's label). */
  driveName: string;
  /** Where the item is: "Drive" or "Drive / A / B". Empty for a drive. */
  location: string;
  /** The label the Drive page opens the item's drive with. */
  openLabel: string;
  /** That label is browsed from the server (not synced on this computer). */
  openRemote: boolean;
  /** What the breadcrumb shows for a `shared:`/`grant:` label; `null` for a plain label. */
  openName: string | null;
  /**
   * Relative to `openLabel`'s root: a folder's own path, a file's parent
   * folder ("" at the root), "" for a drive. `null` when there is no folder
   * to open (a file with no path, or one outside a folder grant's root).
   */
  openPath: string | null;
  /** Files: the uploader, when the server says. */
  uploadedBy: string | null;
  uploadedByName: string | null;
  /**
   * A file's content hash, shown in File Details as the Arion hash, as for
   * a Drive row. Empty for a drive, a folder, or a file not hashed yet.
   */
  arionCid: string;
}

export interface StarredListing {
  /** `false`: the server has no Starred yet (an older server answered 404). */
  available: boolean;
  /** Drives, then folders, then files. */
  items: StarredItem[];
}

/** Star (`favorite: true`) or unstar one item. Rejects with Rust's sentence. */
export function setStar(accountId: string, target: StarTarget, favorite: boolean): Promise<StarResult> {
  return invoke<StarResult>("set_star", { accountId, target, favorite });
}

/** Star or unstar many items, 4 requests at a time, one answer. */
export function setStars(accountId: string, targets: StarTarget[], favorite: boolean): Promise<StarBatchResult> {
  return invoke<StarBatchResult>("set_stars", { accountId, targets, favorite });
}

/**
 * Every item this account starred (up to the 1,000 cap). The Starred page
 * sorts and searches the whole list itself until the server can search it
 * (hcfs#1452).
 */
export function listStarred(accountId: string): Promise<StarredListing> {
  return invoke<StarredListing>("list_starred", { accountId });
}

/** The drive identity behind each label, for [`starKey`]. Unresolvable labels are left out. */
export function starScopes(accountId: string, labels: string[]): Promise<Record<string, StarScope>> {
  return invoke<Record<string, StarScope>>("star_scopes", { accountId, labels });
}

function joinPath(root: string, rel: string): string {
  const a = root.replace(/^\/+|\/+$/g, "");
  const b = rel.replace(/^\/+|\/+$/g, "");
  if (!a) return b;
  if (!b) return a;
  return `${a}/${b}`;
}

/**
 * The key one star is known by, the same string Rust puts on `StarResult.key`
 * and `StarredItem.key` (pinned on both sides): the owner is part of every key
 * because drive hashes come from labels, so two owners' drives can share one.
 *
 * - file: `${owner}|${folderHash}|f:${fileId}`
 * - folder: `${owner}|${folderHash}|d:${path from the drive root}`
 * - drive: `${owner}|${folderHash}|drive`, or for a folder grant's root the
 *   granted folder (`d:${rootPath}`), which is what a grant's "drive" names.
 *
 * `idOrPath` is the file id, or the folder's path relative to the scope's root.
 */
export function starKey(scope: StarScope, kind: StarKind, idOrPath = ""): string {
  const prefix = `${scope.ownerSs58}|${scope.folderHash}|`;
  if (kind === "file") return `${prefix}f:${idOrPath.toLowerCase()}`;
  if (kind === "drive") {
    const root = joinPath(scope.rootPath, "");
    return root ? `${prefix}d:${root}` : `${prefix}drive`;
  }
  return `${prefix}d:${joinPath(scope.rootPath, idOrPath)}`;
}
