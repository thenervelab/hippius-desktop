"use client";

import { createContext, useContext, type ReactNode } from "react";

/** A drive a page is pinned to: the Captures page and the captures drive. */
export interface PinnedDrive {
  label: string;
  /** Not synced on this computer: browsed from the server. */
  remote: boolean;
}

/**
 * The page a drive was opened from, when that is not the Drive page's own
 * folder list: the Shared Drives page.
 */
export interface DriveRouteParent {
  /** The breadcrumb's first crumb, e.g. "Shared Drives". */
  label: string;
  /** Where that crumb, and Back from the drive's root, go. */
  href: string;
}

/**
 * Where the Drive container lives. The Drive page is `/files` with the full
 * folder list; another page can host the same container pinned to one drive
 * (the Captures page), where folder links stay on that page, "up" from the
 * drive's root goes nowhere, and the drive's empty root may say something of
 * its own. The Shared Drives page hosts it too, for the drive a row opened
 * (`parent`): the trail starts at "Shared Drives" and leads back there.
 */
export interface DriveRoute {
  basePath: string;
  pinned: PinnedDrive | null;
  /** Shown instead of the generic empty state at the pinned drive's root. */
  emptyState?: ReactNode;
  /**
   * The page above the drive, when it is not the Drive page's folder list.
   * The drive stays in the URL at every level, root included, so a reload
   * lands in the same place with the same trail.
   */
  parent?: DriveRouteParent;
}

export const DRIVE_PAGE_ROUTE: DriveRoute = { basePath: "/files", pinned: null };

export const DriveRouteContext = createContext<DriveRoute>(DRIVE_PAGE_ROUTE);

export function useDriveRoute(): DriveRoute {
  return useContext(DriveRouteContext);
}
