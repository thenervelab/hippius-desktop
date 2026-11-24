// The Starred page's pure parts: which items show for a search, in what
// order, where opening one goes, and the Drive row each file or folder is
// shown as so the Drive's preview, details and actions work on it.
//
// Rust resolves every drive (`list_starred`): the label to open it with,
// whether it is synced here, the path inside it. Nothing here guesses one.

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { StarredItem } from "@/app/lib/tauri/starred";
import { isSharedDriveLabel } from "@/app/lib/shared-drives/sharedDriveLabel";
import { REMOTE_SOURCE_PREFIX, remoteLabelFromSource } from "@/app/lib/hooks/use-nested-folder-listing";
import { driveRelativePathFor } from "@/app/lib/utils/driveRelativePath";
import { STARRED_ROUTE } from "@/app/lib/routes";

export type StarredSortKey = "name" | "size" | "date";
export type StarredSortDir = "asc" | "desc";
export interface StarredSort {
  key: StarredSortKey;
  dir: StarredSortDir;
}

/** Name A to Z: the order the page opens in. */
export const DEFAULT_STARRED_SORT: StarredSort = { key: "name", dir: "asc" };

/**
 * Whether `name` matches the search box: every word of the query appears in
 * it, in any order, ignoring case. An empty query matches everything.
 */
export function matchesStarredSearch(name: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = name.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Drives, then folders, then files, whatever the sort. */
const KIND_ORDER: Record<StarredItem["kind"], number> = { drive: 0, folder: 1, file: 2 };

function compareBy(a: StarredItem, b: StarredItem, key: StarredSortKey): number {
  if (key === "size") return (a.size ?? -1) - (b.size ?? -1);
  if (key === "date") return (a.createdAt ?? -1) - (b.createdAt ?? -1);
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
}

/**
 * The items a search shows, in the list's order: drives, then folders, then
 * files, each group in the chosen sort (ties by name, then key, so the
 * order is stable). Done here, on the whole list, until the server can
 * search the Starred list too (hcfs#1452); then the page will page and sort
 * on the server like a Drive folder.
 */
export function arrangeStarredItems(
  items: readonly StarredItem[],
  query: string,
  sort: StarredSort = DEFAULT_STARRED_SORT,
): StarredItem[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return items
    .filter((item) => matchesStarredSearch(item.name, query))
    .sort((a, b) => {
      const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      if (kind !== 0) return kind;
      const primary = compareBy(a, b, sort.key) * sign;
      if (primary !== 0) return primary;
      const byName = compareBy(a, b, "name");
      return byName !== 0 ? byName : a.key.localeCompare(b.key);
    });
}

function joinPath(parent: string | null | undefined, name: string): string {
  const p = (parent ?? "").replace(/^\/+|\/+$/g, "");
  return p ? `${p}/${name}` : name;
}

function parentOf(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const at = trimmed.lastIndexOf("/");
  return at < 0 ? "" : trimmed.slice(0, at);
}

/**
 * The Starred page's URL with a drive open on it, at `subfolder`: the drive's
 * container reads the same `open*` parameters on any page that hosts it.
 */
function starredDriveHref(drive: {
  label: string;
  remote: boolean;
  /** What the breadcrumb shows for a `shared:`/`grant:` label. */
  name: string;
  subfolder: string | null;
}): string {
  const params = new URLSearchParams({ openLabel: drive.label });
  if (drive.remote) params.set("openRemote", "1");
  if (isSharedDriveLabel(drive.label)) params.set("openName", drive.name);
  if (drive.subfolder) params.set("openSubfolder", drive.subfolder);
  return `${STARRED_ROUTE}?${params.toString()}`;
}

/** The breadcrumb name of each `shared:`/`grant:` label on the list, for opening its rows. */
export function starredOpenNames(items: readonly StarredItem[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const item of items) {
    if (!names.has(item.openLabel)) names.set(item.openLabel, item.openName ?? item.driveName);
  }
  return names;
}

/**
 * Where a folder or drive row on the Starred page opens: right here, with its
 * drive open at that folder (the rows come from many drives, so the page's
 * own URL cannot say which). Works from the row alone, so a folder inside an
 * expanded starred folder opens too: `parentPath` is the folder it sits in.
 * `openNames` from `starredOpenNames`.
 */
export function starredFolderHref(
  folder: FormattedUserFile,
  parentPath: string | undefined,
  openNames: ReadonlyMap<string, string>,
): string | null {
  const remoteLabel = remoteLabelFromSource(folder.source) ?? folder.remoteDriveLabel ?? null;
  const label = remoteLabel ?? folder.label ?? null;
  if (!label) return null;
  const path = folder.isDriveRoot ? "" : driveRelativePathFor({ ...folder, isFolder: true }, parentPath ?? "");
  return starredDriveHref({
    label,
    remote: remoteLabel !== null,
    name: openNames.get(label) ?? label,
    subfolder: path || null,
  });
}

/**
 * The Drive row a starred item is shown as, so the Drive's own table and
 * grid show, expand, open, preview and act on it as they do their own rows.
 *
 * - A drive is a folder row for the whole drive (`isDriveRoot`): it expands
 *   to the drive's root and opens the drive, and offers nothing that would
 *   act on its sync root as a folder.
 * - A folder carries its full drive-relative path in `actualFileName`, as a
 *   file row does: the list mixes folders from many places, so there is no
 *   one folder on screen to resolve a bare name against.
 * - In a drive synced on this computer (`syncRoot` known) a row is LOCAL (its
 *   path on disk, which rename, delete and the on-disk preview read);
 *   anywhere else it is a server row (a file by its id, a folder by the
 *   `remote://` source).
 */
export function starredItemRow(item: StarredItem, syncRoot: string | null): FormattedUserFile {
  const root = syncRoot ? syncRoot.replace(/[\\/]+$/, "") : null;
  const createdMs = (item.createdAt ?? 0) * 1000;
  const remoteSource = item.openRemote ? `${REMOTE_SOURCE_PREFIX}${item.openLabel}` : undefined;
  const remoteDriveLabel = item.openRemote ? item.openLabel : undefined;

  const base: FormattedUserFile = {
    name: item.name,
    size: item.size ?? undefined,
    createdAt: createdMs,
    arionHash: item.fileId ?? "",
    arionCid: "",
    minerIds: [],
    isAssigned: true,
    lastChargedAt: createdMs,
    isFolder: item.kind !== "file",
    type: "private",
    isErasureCoded: false,
    mainReqHash: "",
    label: item.openLabel,
    syncStatus: "synced",
    favorite: true,
    fileCount: item.fileCount ?? undefined,
    uploadedBy: item.uploadedBy ?? undefined,
    uploadedByName: item.uploadedByName ?? undefined,
    location: item.location || undefined,
  };

  if (item.kind === "drive") {
    return {
      ...base,
      isDriveRoot: true,
      actualFileName: "",
      // Its root on disk where it is synced here, else the server's.
      source: !item.openRemote && root ? root : remoteSource,
      remoteDriveLabel,
      location: undefined,
    };
  }

  if (item.kind === "folder") {
    const path = (item.openPath ?? "").replace(/^\/+|\/+$/g, "");
    const local = !item.openRemote && Boolean(root) && path !== "";
    return {
      ...base,
      actualFileName: path || item.name,
      parentRelativePath: parentOf(path) || undefined,
      source: local ? `${root}/${path}` : path ? remoteSource : undefined,
      remoteDriveLabel,
    };
  }

  const relPath = item.openPath === null ? null : joinPath(item.openPath, item.name);
  if (!item.openRemote && root && relPath) {
    // On disk: no server id, so preview, download and delete take the
    // local path, exactly as a Drive row of a synced drive does.
    return { ...base, actualFileName: relPath, source: `${root}/${relPath}` };
  }
  return {
    ...base,
    actualFileName: relPath ?? item.name,
    fileId: item.fileId ?? undefined,
    remoteDriveLabel,
  };
}
