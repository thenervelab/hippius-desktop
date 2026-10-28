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
