"use client";

import React from "react";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { cn } from "@/lib/utils";
import { rowDropClass, useHoverExpand, useMoveRow } from "./useMoveDnd";

/**
 * A `<tr>` that can be dragged and dropped on (a folder row is that
 * folder, a file row the folder it is listed in). For rows rendered in a
 * loop (an expanded folder's children), where the hooks need a component
 * of their own.
 */
export default function MoveTr({
  file,
  currentFolder,
  disabled,
  onHoverExpand,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLTableRowElement> & {
  file: FormattedUserFile;
  /** The folder the row is listed in, drive-relative. */
  currentFolder: string;
  disabled?: boolean;
  /** Opens the folder when it is hovered mid-drag; unset when it is open. */
  onHoverExpand?: () => void;
}) {
  const move = useMoveRow(file, currentFolder, { disabled });
  useHoverExpand(Boolean(onHoverExpand) && move.dropState === "valid", () => onHoverExpand?.());
  return (
    <tr
      ref={move.setRef}
      {...rest}
      {...move.dragProps}
      className={cn(className, move.isDragging && "opacity-50", rowDropClass(move.dropState, move.groupRole))}
    >
      {children}
    </tr>
  );
}
