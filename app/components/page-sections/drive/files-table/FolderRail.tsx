"use client";

import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Inline chevron slot rendered at the start of every Name cell.
 *
 * Width is fixed (20px) so folders and files always align icon-to-icon
 * regardless of whether the row is expandable. Three states:
 * - Folder + interactive: clickable chevron button
 * - Folder + non-interactive (e.g. Recent Files): static chevron icon
 * - File: empty spacer of the same width
 *
 * The Figma calls for no vertical divider between this slot and the
 * file/folder icon, so this lives inside the Name `<td>` rather than
 * in its own column.
 */
export const NameCellExpander = ({
  expanded,
  onToggle,
  interactive,
  isFolder,
}: {
  expanded: boolean;
  onToggle?: () => void;
  interactive: boolean;
  isFolder: boolean;
}) => {
  if (!isFolder) {
    return <div aria-hidden className="flex w-5 shrink-0" />;
  }

  const icon = expanded ? (
    <ChevronDown className="size-4" />
  ) : (
    <ChevronRight className="size-4" />
  );

  if (!interactive) {
    return (
      <div className="flex size-5 shrink-0 items-center justify-center text-grey-60 dark:text-grey-dark-700">
        {icon}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle?.();
      }}
      className={cn(
        "folder-expander-area flex size-5 shrink-0 items-center justify-center rounded",
        "text-grey-60 transition-colors hover:text-grey-20",
        "dark:text-grey-dark-700 dark:hover:text-grey-dark-200",
      )}
      aria-label={expanded ? "Collapse folder" : "Expand folder"}
    >
      {icon}
    </button>
  );
};
