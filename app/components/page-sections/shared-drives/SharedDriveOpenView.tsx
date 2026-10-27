"use client";

// A drive opened from the Shared Drives page, shown on that page.
//
// Rows on the page used to open their drive on the Drive page (`/files`),
// which made the trail read "Drive › drive", sent Back from the drive's
// root to Drive's folder list, and moved the sidebar's selection to Drive.
// Hosting the same drive container here, with the page as its `parent`,
// keeps all three on Shared Drives. The drive stays in the URL at every
// level (`/shared-drives?openLabel=…` at its root, the nested folder params
// below it), so a reload lands in the same place with the same trail.

import { useEffect, type ReactNode } from "react";
import { useSetAtom } from "jotai";

import DriveContainer from "@/components/page-sections/drive/DriveContainer";
import { DriveRouteContext, type DriveRoute } from "@/components/page-sections/drive/driveRoute";
import { fileDetailsPanelAtom } from "@/app/lib/global-atoms/fileDetailsAtoms";
import { SHARED_DRIVES_ROUTE } from "@/app/lib/routes";

/** The breadcrumb's first crumb, and the page Back from a drive's root returns to. */
export const SHARED_DRIVES_ROOT_LABEL = "Shared Drives";

export const SHARED_DRIVES_DRIVE_ROUTE: DriveRoute = {
  basePath: SHARED_DRIVES_ROUTE,
  pinned: null,
  parent: { label: SHARED_DRIVES_ROOT_LABEL, href: SHARED_DRIVES_ROUTE },
};

export default function SharedDriveOpenView({ header }: { header?: ReactNode }) {
  // A file's details belong to the drive they were opened in; the panel is
  // mounted at the layout level, so leaving the drive has to close it.
  const setFileDetails = useSetAtom(fileDetailsPanelAtom);
  useEffect(() => () => setFileDetails(null), [setFileDetails]);

  return (
    <>
      {header}
      <DriveRouteContext.Provider value={SHARED_DRIVES_DRIVE_ROUTE}>
        <DriveContainer />
      </DriveRouteContext.Provider>
    </>
  );
}
