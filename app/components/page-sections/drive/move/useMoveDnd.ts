"use client";

import { useCallback, useEffect, useRef } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { moveItemFor, moveProblem } from "@/app/lib/drive-move/moveLogic";
import { useDriveMove, type MoveDragData, type MoveDropData } from "./DriveMoveProvider";

/** How a drop target looks while something is dragged over it. */
export type DropState = "valid" | "invalid" | null;

/** Classes for a drop target, from the existing accent and hover tokens. */
export function dropStateClass(state: DropState): string | undefined {
  if (state === "valid") return "!bg-primary-60/10 outline outline-1 -outline-offset-1 outline-primary-50";
  if (state === "invalid") return "cursor-not-allowed";
  return undefined;
}

/** How long a collapsed folder is hovered during a drag before it opens. */
export const HOVER_EXPAND_MS = 700;

/**
 * A folder (row, card, breadcrumb crumb) that takes a drop. Inert outside
 * a drive folder view or when `path` is null.
 */
export function useMoveDropTarget(path: string | null, name: string, labelKey = "") {
  const move = useDriveMove();
  const data: MoveDropData = { kind: "move-folder", path: path ?? "", name };
  const drop = useDroppable({
    id: `drop:${labelKey}:${path ?? ""}`,
    data,
    disabled: !move || path === null,
  });
  let state: DropState = null;
  if (move?.drag && drop.isOver && path !== null) {
    state = moveProblem(move.drag.items, path, move.target.readOnlyReason) ? "invalid" : "valid";
  }
  return { setNodeRef: drop.setNodeRef, isOver: drop.isOver, state };
}

/**
 * A row or card that can be dragged and, for a folder, dropped on.
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
  const drop = useMoveDropTarget(file.isFolder ? item.path : null, item.name, file.label ?? "");

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
    dropState: drop.state,
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
