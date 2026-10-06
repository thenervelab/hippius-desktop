"use client";

import { createContext, useContext, type ReactNode } from "react";

/** A drive a page is pinned to: the Captures page and the captures drive. */
export interface PinnedDrive {
  label: string;
  /** Not synced on this computer: browsed from the server. */
  remote: boolean;
}

/**
 * Where the Drive container lives. The Drive page is `/files` with the full
 * folder list; another page can host the same container pinned to one drive
 * (the Captures page), where folder links stay on that page, "up" from the
 * drive's root goes nowhere, and the drive's empty root may say something of
 * its own.
 */
export interface DriveRoute {
  basePath: string;
  pinned: PinnedDrive | null;
  /** Shown instead of the generic empty state at the pinned drive's root. */
  emptyState?: ReactNode;
}

export const DRIVE_PAGE_ROUTE: DriveRoute = { basePath: "/files", pinned: null };

export const DriveRouteContext = createContext<DriveRoute>(DRIVE_PAGE_ROUTE);

export function useDriveRoute(): DriveRoute {
  return useContext(DriveRouteContext);
}
