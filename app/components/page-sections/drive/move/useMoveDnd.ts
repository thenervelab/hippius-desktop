"use client";

import { useCallback, useEffect, useRef } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { basenameOf, moveItemFor, normalizePath } from "@/app/lib/drive-move/moveLogic";
import {
  dropGroupRole,
  dropVerdict,
  rowDropFolder,
  type DropRow,
} from "@/app/lib/drive-move/dropTarget";
import { useDriveMove, type MoveDragData, type MoveDropData } from "./DriveMoveProvider";

/** How a drop target looks while something is dragged over it. */
export type DropState = "valid" | "invalid" | null;

/** How a row joins the highlight of the folder a drag is over. */
export type DropGroupRole = "target" | "member" | null;

const VALID_CLASS = "!bg-primary-60/10 outline outline-1 -outline-offset-1 outline-primary-50";
const MEMBER_CLASS = "!bg-primary-60/10";

/** Classes for a drop target, from the existing accent and hover tokens. */
export function dropStateClass(state: DropState): string | undefined {
  if (state === "valid") return VALID_CLASS;
  if (state === "invalid") return "cursor-not-allowed";
  return undefined;
}

/**
 * Classes for a row in the table: the target folder's row is outlined,
 * every row inside it is tinted, so the level a drop lands in reads as
 * one block. A row the pointer is on that refuses the drop shows the
 * not-allowed cursor.
 */
export function rowDropClass(state: DropState, role: DropGroupRole): string | undefined {
  if (role === "target") return VALID_CLASS;
  if (role === "member") return MEMBER_CLASS;
  return state === "invalid" ? "cursor-not-allowed" : undefined;
}

/** How long a collapsed folder is hovered during a drag before it opens. */
export const HOVER_EXPAND_MS = 700;

/**
 * A drop target for the folder `path` (a row, card, breadcrumb crumb).
 * Inert outside a drive folder view or when `path` is null.
 *
 * `idKey` keeps the target's id unique where several targets stand for
 * one folder (every file row in a folder does). `rowPath` is the row's
 * own path, so a row being dragged never offers a drop onto itself.
 */
export function useMoveDropTarget(path: string | null, name: string, idKey = "", rowPath: string | null = null) {
  const move = useDriveMove();
  const data: MoveDropData = { kind: "move-folder", path: path ?? "", name, rowPath };
  const drop = useDroppable({
    id: `drop:${idKey}:${path ?? ""}`,
    data,
    disabled: !move || path === null,
  });
  let state: DropState = null;
  if (move?.drag && drop.isOver && path !== null) {
    const verdict = dropVerdict(move.drag.items, { path, name }, rowPath, move.target.readOnlyReason);
    state = verdict.kind === "none" ? null : verdict.kind;
  }
  return { setNodeRef: drop.setNodeRef, isOver: drop.isOver, state };
}

/**
 * This row's part in the highlight of the folder the drag is over (see
 * `dropGroupRole`). Only a drop that would move something lights up.
 */
export function useDropGroupRole(row: DropRow | null, listedIn: string): DropGroupRole {
  const over = useDriveMove()?.drag?.over;
  if (!over || over.verdict.kind !== "valid") return null;
  return dropGroupRole(row, listedIn, over.path);
}

/**
 * A row or card that can be dragged and dropped on.
 *
 * Every row is a target, Finder's way: a folder row is that folder, and
 * any other row is the folder it is listed in (`currentFolder`), so a
 * drop on a file inside an expanded folder lands in that folder.
 *
 * Draggable only where Move to… would be enabled (`offersMove` +
 * `canMove`, the Rename gate). The node also blocks native HTML drag of
 * anything inside it, which would otherwise end the pointer drag and can
 * reach the window as a Finder-style drop.
 */
export function useMoveRow(file: FormattedUserFile, currentFolder: string, options?: { disabled?: boolean }) {
  const move = useDriveMove();
  const item = moveItemFor(file, currentFolder);
  const key = `${file.label ?? ""}:${item.path}`;
  const canDrag = Boolean(move && !options?.disabled && move.offersMove(file) && move.canMove(file));
  const dragData: MoveDragData = { kind: "move-row", file, currentFolder };
  const drag = useDraggable({ id: `drag:${key}`, data: dragData, disabled: !canDrag });
  const listedIn = normalizePath(currentFolder);
  const row: DropRow = { path: item.path, isFolder: item.isFolder, name: item.name };
  const folder = rowDropFolder(row, {
    path: listedIn,
    name: basenameOf(listedIn) || move?.target.driveName || "",
  });
  const drop = useMoveDropTarget(folder.path, folder.name, `${file.label ?? ""}|row:${item.path}`, item.path);
  const groupRole = useDropGroupRole(row, listedIn);

  const setRef = useCallback(
    (el: HTMLElement | null) => {
      drag.setNodeRef(el);
      drag.setActivatorNodeRef(el);
      drop.setNodeRef(el);
    },
    // The setters are stable for a given id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drag.setNodeRef, drag.setActivatorNodeRef, drop.setNodeRef],
  );

  // `role` stays the element's own (a table row, a card); the rest makes
  // it focusable and announces it to the keyboard sensor.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { role: _role, ...attributes } = drag.attributes;
  const dragProps = canDrag
    ? {
        ...attributes,
        ...drag.listeners,
        onDragStart: (event: React.DragEvent) => event.preventDefault(),
      }
    : { onDragStart: (event: React.DragEvent) => event.preventDefault() };

  return {
    setRef,
    dragProps,
    isDragging: drag.isDragging,
    /** The pointer is on this row: valid, refused, or nothing to do. */
    dropState: drop.state,
    /** Lit as the target folder, as a row inside it, or not at all. */
    groupRole,
    isOver: drop.isOver,
  };
}

/** Open a collapsed folder after it is hovered for a moment mid-drag. */
export function useHoverExpand(active: boolean, expand: () => void) {
  const expandRef = useRef(expand);
  expandRef.current = expand;
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => expandRef.current(), HOVER_EXPAND_MS);
    return () => window.clearTimeout(timer);
  }, [active]);
}
