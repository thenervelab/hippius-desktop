"use client";

import React from "react";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { cn } from "@/lib/utils";
import { rowDropClass, useMoveRow } from "./useMoveDnd";

/** A card wrapper that can be dragged and dropped on, like a table row. */
export default function MoveCard({
  file,
  currentFolder,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  file: FormattedUserFile;
  currentFolder: string;
}) {
  const move = useMoveRow(file, currentFolder);
  return (
    <div
      ref={move.setRef}
      {...rest}
      {...move.dragProps}
      className={cn(
        className,
        "rounded-lg",
        move.isDragging && "opacity-50",
        rowDropClass(move.dropState, move.groupRole),
      )}
    >
      {children}
    </div>
  );
}
