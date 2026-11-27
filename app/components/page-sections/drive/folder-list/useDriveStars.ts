"use client";

// Star / Unstar for drive rows (the folder list on the Drive page, Settings
// and Shared Drives), keyed by each row's label.

import { useMemo } from "react";
import { useStars } from "@/app/lib/starred/useStars";
import { folderRowLabel, type FolderRow } from "./folderRows";

/** The `star` handlers `buildFolderActions` takes, for `rows`. */
export function useDriveStars(rows: readonly FolderRow[] = []) {
  const labels = useMemo(() => rows.map(folderRowLabel), [rows]);
  const { isDriveStarred, toggleDrive } = useStars(labels);
  return useMemo(
    () => ({
      isStarred: (row: FolderRow) => isDriveStarred(folderRowLabel(row)),
      onToggle: (row: FolderRow) => void toggleDrive(folderRowLabel(row), row.folderName),
    }),
    [isDriveStarred, toggleDrive],
  );
}
