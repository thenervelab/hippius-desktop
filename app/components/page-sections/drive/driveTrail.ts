// Pure rules for the drive breadcrumb and the way back out of a drive.
// Unit-tested in `__tests__/driveTrail.test.ts`.
//
// The trail has a root crumb, then the open drive, then one crumb per
// folder below it. The root is the page the drive was opened from: the
// Drive page's folder list, or another page that hosts the drive container
// (`DriveRoute.parent`, the Shared Drives page). Everything here takes the
// route so the trail, Back and a reload all answer from the same facts.

import { openDriveHref, type DriveToOpen } from "@/app/lib/routes";
import { isNestedFolderView } from "@/app/lib/utils/filesViewMode";
import { REMOTE_SOURCE_PREFIX } from "@/app/lib/hooks/use-nested-folder-listing";
import type { DriveRoute, PinnedDrive } from "./driveRoute";

/** Where a crumb goes. `null` on the crumb for the current location. */
export type TrailTarget =
  | { kind: "drive"; label: string; remote: boolean }
  | { kind: "folder"; name: string; subPath: string };

/** One crumb after the root. */
export interface TrailStep {
  label: string;
  target: TrailTarget | null;
}

/**
 * The crumbs after the root: the open drive, then each folder down to the
 * one on screen. The last crumb is the current location and goes nowhere.
 *
 * `subFolderPath` is rooted at `mainFolderActualName` ("Photos/2024" under
 * "Photos"), as the nested folder URLs carry it.
 */
export function driveTrail(input: {
  drive: { label: string; remote: boolean; name: string } | null;
  nested: boolean;
  subFolderPath: string | null | undefined;
  mainFolderActualName: string | null | undefined;
}): TrailStep[] {
  const steps: TrailStep[] = [];
  const { drive, nested } = input;
  if (drive) {
    steps.push({
      label: drive.name,
      // At the drive's root the crumb IS the current location.
      target: nested ? { kind: "drive", label: drive.label, remote: drive.remote } : null,
    });
  }
  if (!nested || !input.subFolderPath) return steps;

  const mainName = input.mainFolderActualName || "";
  const parts: string[] = mainName ? [mainName] : [];
  let trailing = input.subFolderPath;
  if (mainName && trailing.startsWith(`${mainName}/`)) {
    trailing = trailing.substring(mainName.length + 1);
  } else if (trailing === mainName) {
    trailing = "";
  }
  parts.push(...trailing.split("/").filter(Boolean));

  parts.forEach((part, idx) => {
    const isLast = idx === parts.length - 1;
    steps.push({
      label: part,
      target: isLast ? null : { kind: "folder", name: part, subPath: parts.slice(0, idx + 1).join("/") },
    });
  });
  return steps;
}

/**
 * The URL for a crumb that jumps back to the drive's root.
 *
 * On the Drive page a drive's root is view state, not a URL, so the jump is
 * to the bare page and the container switches drives itself. A page with a
 * `parent` keeps the drive in the URL instead: without it the page would
 * show its own list (the drive is open only while the URL says so), and a
 * reload would forget which drive was open.
 */
export function driveRootHref(
  route: Pick<DriveRoute, "basePath" | "parent">,
  drive: DriveToOpen,
): string {
  return route.parent ? openDriveHref(route.basePath, drive) : route.basePath;
}

/**
 * What to do with the URL once the drive it asked for is open: the URL to
 * replace it with, or `null` to leave it.
 *
 * The Drive page clears the request, so going back to its list and
 * reloading does not drop the user into the drive again. A page with a
 * `parent` keeps it, since there the URL is the only record of which drive
 * is on screen; it drops only the one-shot parts (the subfolder to step
 * into, the file to point out), which would otherwise replay on a reload.
 */
export function urlAfterOpen(
  route: Pick<DriveRoute, "basePath" | "parent">,
  request: DriveToOpen & { subfolder?: string | null; file?: string | null },
): string | null {
  if (!route.parent) return route.basePath;
  if (!request.subfolder && !request.file) return null;
  return openDriveHref(route.basePath, request);
}

/**
 * Where the container starts before any effect has run.
 *
 * The Drive page starts on its folder list, and a pinned page (Captures) in
 * its drive. A page with a `parent` mounts the container only while a drive
 * is in the URL, so it starts in that drive: starting on a folder list that
 * page does not have would paint one wrong frame, and the folder-list
 * fallback would open the first synced drive in its place.
 */
export function initialDriveView(input: {
  pinned: PinnedDrive | null;
  parent: DriveRoute["parent"];
  open: { label: string; remote: boolean } | null;
}): { syncLabel: string | null; remoteLabel: string | null; onFolderList: boolean } {
  if (input.pinned) {
    return {
      syncLabel: input.pinned.remote ? null : input.pinned.label,
      remoteLabel: input.pinned.remote ? input.pinned.label : null,
      onFolderList: false,
    };
  }
  if (input.parent) {
    const open = input.open;
    return {
      syncLabel: open && !open.remote ? open.label : null,
      remoteLabel: open?.remote ? open.label : null,
      onFolderList: false,
    };
  }
  return { syncLabel: null, remoteLabel: null, onFolderList: true };
}

/**
 * Whether a page that hosts the drive container (Shared Drives) has a drive
 * open: a drive at its root (`openLabel`), or a folder inside one (the
 * nested folder params). Read from the URL alone, so a reload answers the
 * same as the click that got there.
 */
export function isDriveOpenInUrl(getParam: (key: string) => string | null | undefined): boolean {
  if (getParam("openLabel")) return true;
  return isNestedFolderView({
    folderName: getParam("folderName"),
    subFolderPath: getParam("subFolderPath"),
  });
}

// ── A page rooted at a folder inside a drive ─────────────────────────────
//
// Captures kept in a folder of another drive (`PinnedDrive.folder`): the
// Captures page lists that folder and what is under it, and nothing above
// it. These answer, from the URL alone, where the page's root is, whether
// the view on screen is inside it, and what the trail shows from there.

/** A folder path as compared here: no leading, trailing or doubled `/`. */
function folderPathOf(path: string | null | undefined): string {
  return (path ?? "").split("/").filter(Boolean).join("/");
}

/**
 * The URL of the folder a pinned page is rooted at, built the way a
 * breadcrumb jump builds a folder's URL, or `null` when the page is pinned
 * to a whole drive, or when a drive synced here has no folder known yet
 * (`syncPath`), so there is nothing to point the listing at.
 */
export function pinnedFolderHref(
  basePath: string,
  pinned: PinnedDrive | null,
  syncPath: string | null | undefined,
): string | null {
  const folder = folderPathOf(pinned?.folder);
  if (!pinned || !folder) return null;
  // The listing finds its drive by this: `remote://<label>` for one browsed
  // from the server, a path inside the drive's own folder for one synced here.
  const source = pinned.remote
    ? `${REMOTE_SOURCE_PREFIX}${pinned.label}`
    : syncPath
      ? `${syncPath.replace(/\/+$/, "")}/${folder}`
      : null;
  if (!source) return null;
  const parts = folder.split("/");
  const name = parts[parts.length - 1];
  const params = new URLSearchParams();
  params.set("folderName", name);
  params.set("folderActualName", name);
  params.set("mainFolderActualName", parts[0]);
  params.set("subFolderPath", folder);
  params.set("folderSource", source);
  return `${basePath}?${params.toString()}`;
}

/**
 * Whether the view on screen is the pinned folder or a folder under it.
 * Always true for a page pinned to a whole drive. The drive's root, or any
 * folder beside the pinned one, is outside it.
 */
export function isInsidePinnedFolder(
  pinned: PinnedDrive | null,
  nested: boolean,
  subFolderPath: string | null | undefined,
): boolean {
  const folder = folderPathOf(pinned?.folder);
  if (!folder) return true;
  if (!nested) return false;
  const path = folderPathOf(subFolderPath);
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * Whether the view on screen is the pinned page's own root: the pinned
 * drive's root, or the pinned folder itself. That is where the page shows
 * its own empty state.
 */
export function isPinnedRoot(pinned: PinnedDrive | null, subFolderPath: string | null | undefined): boolean {
  if (!pinned) return false;
  return folderPathOf(subFolderPath) === folderPathOf(pinned.folder);
}

/**
 * The trail on a page rooted at a folder: it starts at that folder, since
 * the drive and the folders above it are not part of the page. Unchanged
 * for a page pinned to a whole drive.
 */
export function trailFromPinnedFolder(steps: TrailStep[], pinned: PinnedDrive | null): TrailStep[] {
  const folder = folderPathOf(pinned?.folder);
  if (!folder) return steps;
  // `steps` is the drive, then one crumb per folder from the drive's root,
  // so the pinned folder's own crumb is at its depth.
  const depth = folder.split("/").length;
  return steps.length > depth ? steps.slice(depth) : steps;
}
