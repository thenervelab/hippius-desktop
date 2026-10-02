"use client";

import React from "react";
import { Folder } from "lucide-react";

import { cn } from "@/lib/utils";
import { driveChipVariants } from "./DriveRoleChip";

/** The chip's hover text, exported so tests and callers say one thing. */
export const FOLDER_GRANT_CHIP_TITLE =
  "A folder within someone's drive, shared with you on its own";

/**
 * Says that a "Shared with me" row, or the view it opens, is one folder of
 * somebody's drive rather than a whole drive. The console's `FolderGrantChip`,
 * same words and meaning, drawn with this app's chip variants.
 *
 * Without it a folder called "Invoices" and a whole drive called "Invoices"
 * look the same, and they are very different things: one is everything in
 * the drive, the other is one corner of it.
 *
 * It does not name the drive. The owner shared a folder, not the drive, so
 * the drive's name is not the recipient's to see.
 *
 * Neutral, like the Viewer chip, because it states a shape rather than a
 * power.
 */
export default function FolderGrantChip({ className }: { className?: string }) {
  return (
    <span
      title={FOLDER_GRANT_CHIP_TITLE}
      className={cn(driveChipVariants({ tone: "neutral" }), "gap-1", className)}
    >
      <Folder className="size-3 shrink-0" aria-hidden="true" />
      <span className="whitespace-nowrap">Folder in a drive</span>
    </span>
  );
}
