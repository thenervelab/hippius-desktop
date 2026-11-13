"use client";

import React, { useId } from "react";
import { cn } from "@/lib/utils";
import { basenameOf, normalizePath } from "@/app/lib/drive-move/moveLogic";
import { rowDropClass, useDropGroupRole, useMoveDropTarget } from "./useMoveDnd";

/**
 * A placeholder `<tr>` under an expanded folder (loading, "Folder is
 * empty") that takes a drop into that folder and lights up with it.
 *
 * Being a target also matters while nothing is dropped: the drag measures
 * where its targets are when the set of targets changes, so an expansion
 * that added no target (an empty folder) left every row below it measured
 * at its old position and drops landed on the wrong row.
 */
export default function MoveDropTr({
  folderPath,
  label,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLTableRowElement> & {
  /** The expanded folder this row sits under, drive-relative. */
  folderPath: string;
  /** The drive's label, to keep the target's id unique. */
  label?: string;
}) {
  const id = useId();
  const path = normalizePath(folderPath);
  const drop = useMoveDropTarget(path, basenameOf(path), `${label ?? ""}|placeholder:${id}`);
  const role = useDropGroupRole(null, path);
  return (
    <tr ref={drop.setNodeRef} {...rest} className={cn(className, rowDropClass(drop.state, role))}>
      {children}
    </tr>
  );
}
