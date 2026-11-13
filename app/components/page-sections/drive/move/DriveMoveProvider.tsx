"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useFileSelection, selectionKey } from "@/app/contexts/FileSelectionContext";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import { getUserPreference, saveUserPreference } from "@/app/lib/utils/userPreferencesDb";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { canRenameFile } from "@/app/lib/utils/renameGating";
import { offersWriteAction } from "@/app/lib/utils/folderShareGating";
import {
  useMemberDriveLabels,
  useWritableMemberDriveLabels,
} from "@/app/lib/hooks/useSharedDriveRoles";
import {
  MOVE_HINT_PREF,
  dragLabel,
  failedMessage,
  moveItemFor,
  movedMessage,
  undoRequests,
  type MoveItem,
} from "@/app/lib/drive-move/moveLogic";
import { dropVerdict, type DropVerdict } from "@/app/lib/drive-move/dropTarget";
import { moveEntries, runMove, type Clash, type ClashAnswers } from "@/app/lib/drive-move/runMove";
import { setInAppDragActive, suppressNextClick } from "@/app/lib/drive-move/inAppDrag";
import { cn } from "@/lib/utils";
import MoveDialog from "./MoveDialog";
import NameClashDialog from "./NameClashDialog";

/** The drive and folder on screen, where a move starts from. */
export interface MoveTarget {
  label: string;
  remote: boolean;
  /** The folder on screen, relative to the drive; empty at its top level. */
  parentPath: string;
  /** What the drive is called, for the picker and "Moved to …". */
  driveName: string;
  /** Local folder of a synced drive, for the picker's listing. */
  syncPath: string | null;
  /** Why nothing here can be moved (a Viewer, a frozen drive), or null. */
  readOnlyReason: string | null;
}

/** What is being dragged, the folder it is over, and what a drop would do. */
interface DragState {
  items: MoveItem[];
  over: { path: string; name: string; verdict: DropVerdict } | null;
}

interface DriveMoveContextValue {
  target: MoveTarget;
  drag: DragState | null;
  /** Whether a row's menus offer Move to…: the Rename gate, exactly. */
  offersMove: (file: FormattedUserFile) => boolean;
  /** Whether Move to… is enabled for it (settled, like Rename). */
  canMove: (file: FormattedUserFile) => boolean;
  /** Open the picker for these rows, listed in `currentFolder`. */
  openMoveDialog: (files: FormattedUserFile[], currentFolder?: string | null) => void;
  /** Move straight to a folder (a drop), with the clash prompt and Undo. */
  moveTo: (items: MoveItem[], destination: string, destinationName: string) => Promise<void>;
  /** The one-time drag tip was seen; null until the preference is read. */
  hintSeen: boolean | null;
  dismissHint: () => void;
}

const DriveMoveContext = createContext<DriveMoveContextValue | null>(null);

/** The move context, or null outside a drive folder view. */
export function useDriveMove(): DriveMoveContextValue | null {
  return useContext(DriveMoveContext);
}

/** Drag data a row carries. */
export interface MoveDragData {
  kind: "move-row";
  file: FormattedUserFile;
  currentFolder: string;
}

/**
 * Drop data a target carries: the folder a drop there lands in, and for a
 * row its own path (a file row stands for the folder it is listed in).
 */
export interface MoveDropData {
  kind: "move-folder";
  path: string;
  name: string;
  rowPath?: string | null;
}

/** The folder a drop on `data` lands in, and what it would do. */
function overFor(
  items: readonly MoveItem[],
  data: MoveDropData | undefined,
  readOnlyReason: string | null,
): DragState["over"] {
  if (data?.kind !== "move-folder") return null;
  const folder = { path: data.path, name: data.name };
  return { ...folder, verdict: dropVerdict(items, folder, data.rowPath ?? null, readOnlyReason) };
}

/**
 * Pointer drags start on a row only past 6px, and never from a control
 * inside it (the row menu, a checkbox, the folder chevron, a text field):
 * those keep their own click.
 */
const IGNORED_DRAG_TARGETS =
  ".action-menu-area, .checkbox-container, [role='checkbox'], .folder-expander-area, input, textarea, [role='menu'], [role='menuitem']";

class RowPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: React.PointerEvent) => {
        if (!nativeEvent.isPrimary || nativeEvent.button !== 0) return false;
        const el = nativeEvent.target as Element | null;
        return !el?.closest?.(IGNORED_DRAG_TARGETS);
      },
    },
  ];
}

/** Over a target by the pointer; by nearest box for a keyboard drag. */
const collision: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);

/**
 * Pin the label to the pointer rather than to the dragged row's corner: a
 * row is as wide as the table, so its corner can be far from the cursor.
 */
const followPointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!draggingNodeRect || !activatorEvent || !("clientX" in activatorEvent)) {
    return transform;
  }
  const event = activatorEvent as PointerEvent;
  return {
    ...transform,
    x: transform.x + event.clientX - draggingNodeRect.left + 12,
    y: transform.y + event.clientY - draggingNodeRect.top + 12,
  };
};

interface ClashRequest {
  clashes: Clash[];
  destinationName: string;
  resolve: (answers: ClashAnswers | null) => void;
}

/**
 * Moving within a drive: the Move to… picker, drag and drop, the name
 * clash prompt, and the result toast with Undo. Mounted around a drive
 * folder view (header and rows), so the breadcrumb is a drop target too.
 * Rendered with `target` null, it adds nothing and offers nothing.
 */
export default function DriveMoveProvider({
  target,
  children,
}: {
  target: MoveTarget | null;
  children: React.ReactNode;
}) {
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();
  const { selectedFiles, clearSelection } = useFileSelection();
  const memberDriveLabels = useMemberDriveLabels();
  const writableMemberDriveLabels = useWritableMemberDriveLabels();
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dialogItems, setDialogItems] = useState<MoveItem[] | null>(null);
  const [clashRequest, setClashRequest] = useState<ClashRequest | null>(null);
  const busy = useRef(false);
  const [hintSeen, setHintSeen] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getUserPreference<boolean>(MOVE_HINT_PREF)
      .then((v) => {
        if (!cancelled) setHintSeen(Boolean(v));
      })
      .catch(() => {
        if (!cancelled) setHintSeen(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Never again once dismissed, or once a move has happened at all.
  const dismissHint = useCallback(() => {
    setHintSeen(true);
    void saveUserPreference(MOVE_HINT_PREF, true).catch(() => {});
  }, []);

  const sensors = useSensors(
    useSensor(RowPointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const askClashes = useCallback(
    (destinationName: string) => (clashes: Clash[]) =>
      new Promise<ClashAnswers | null>((resolve) => {
        setClashRequest({ clashes, destinationName, resolve });
      }),
    [],
  );

  const moveTo = useCallback(
    async (items: MoveItem[], destination: string, destinationName: string) => {
      if (!target || !polkadotAddress || items.length === 0 || busy.current) return;
      busy.current = true;
      const drive = { label: target.label, remote: target.remote };
      const toastId = toast.loading(
        items.length === 1 ? `Moving "${items[0].name}"…` : `Moving ${items.length} items…`,
      );
      try {
        const results = await runMove(polkadotAddress, drive, destination, items, askClashes(destinationName));
        const moved = results.filter((r) => r.status === "moved").length;
        const success = movedMessage(moved, destinationName);
        const failure = failedMessage(results);
        const undo = undoRequests(results);
        if (success) {
          toast.success(success, {
            id: toastId,
            description: failure ?? undefined,
            action: undo
              ? {
                  label: "Undo",
                  onClick: () => {
                    void (async () => {
                      try {
                        const back = (
                          await Promise.all(
                            undo.map((req) => moveEntries(polkadotAddress, drive, req.destination, req.items)),
                          )
                        ).flat();
                        const notBack = back.filter((r) => r.status !== "moved").length;
                        if (notBack > 0) {
                          toast.error(
                            notBack === 1 ? "1 item couldn't be moved back" : `${notBack} items couldn't be moved back`,
                          );
                        }
                      } catch (error) {
                        toast.error(errorMessage(error));
                      } finally {
                        await notifyFilesMutated(queryClient, polkadotAddress);
                      }
                    })();
                  },
                }
              : undefined,
          });
          dismissHint();
          clearSelection();
        } else if (failure) {
          toast.error(failure, { id: toastId });
        } else {
          toast.dismiss(toastId);
        }
        if (moved > 0) await notifyFilesMutated(queryClient, polkadotAddress);
      } catch (error) {
        toast.error(errorMessage(error), { id: toastId });
      } finally {
        busy.current = false;
      }
    },
    [target, polkadotAddress, askClashes, queryClient, clearSelection, dismissHint],
  );

  const offersMove = useCallback(
    (file: FormattedUserFile) =>
      Boolean(target) &&
      !target?.readOnlyReason &&
      offersWriteAction(file, memberDriveLabels, writableMemberDriveLabels),
    [target, memberDriveLabels, writableMemberDriveLabels],
  );

  const openMoveDialog = useCallback(
    (files: FormattedUserFile[], currentFolder?: string | null) => {
      if (!target) return;
      const folder = currentFolder ?? target.parentPath;
      setDialogItems(files.map((f) => moveItemFor(f, f.isFolder ? (f.parentRelativePath ?? folder) : folder)));
    },
    [target],
  );

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current as MoveDragData | undefined;
      if (!data || data.kind !== "move-row") return;
      // A selected row carries the whole selection, else just itself.
      const key = selectionKey({ ...data.file, parentRelativePath: data.file.isFolder ? data.currentFolder : data.file.parentRelativePath });
      const fromSelection = selectedFiles.some((f) => selectionKey(f) === key);
      const files = fromSelection ? selectedFiles : [data.file];
      const items = files.map((f) =>
        moveItemFor(f, f === data.file || !f.parentRelativePath ? data.currentFolder : f.parentRelativePath),
      );
      setInAppDragActive(true);
      setDrag({ items, over: null });
    },
    [selectedFiles],
  );

  const readOnlyReason = target?.readOnlyReason ?? null;
  const onDragOver = useCallback(
    (event: DragOverEvent) => {
      const data = event.over?.data.current as MoveDropData | undefined;
      setDrag((prev) => (prev ? { ...prev, over: overFor(prev.items, data, readOnlyReason) } : prev));
    },
    [readOnlyReason],
  );

  const endDrag = useCallback(() => {
    setInAppDragActive(false);
    setDrag(null);
  }, []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const current = drag;
      endDrag();
      suppressNextClick();
      if (!current || !target) return;
      const over = overFor(current.items, event.over?.data.current as MoveDropData | undefined, target.readOnlyReason);
      // Only a drop that moves something: a folder's own siblings, the
      // dragged row itself and a folder into itself all do nothing.
      if (!over || over.verdict.kind !== "valid") return;
      void moveTo(current.items, over.path, over.name);
    },
    [drag, endDrag, target, moveTo],
  );

  // A drag the provider never saw end (unmounted mid-drag) must not leave
  // the Finder-drop listener standing down.
  useEffect(() => () => setInAppDragActive(false), []);

  const value = useMemo<DriveMoveContextValue | null>(
    () =>
      target
        ? { target, drag, offersMove, canMove: canRenameFile, openMoveDialog, moveTo, hintSeen, dismissHint }
        : null,
    [target, drag, offersMove, openMoveDialog, moveTo, hintSeen, dismissHint],
  );

  if (!target || !value) return <>{children}</>;

  const verdict = drag?.over?.verdict;
  const problem = verdict?.kind === "invalid" ? verdict.reason : null;
  const overName = verdict && verdict.kind !== "none" ? (drag?.over?.name ?? null) : null;

  return (
    <DriveMoveContext.Provider value={value}>
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={endDrag}
        accessibility={{
          screenReaderInstructions: {
            draggable: "Press Space to pick this up, the arrow keys to move it onto a folder, Space to drop it, or Escape to cancel.",
          },
        }}
      >
        {children}
        <DragOverlay modifiers={[followPointer]} dropAnimation={null}>
          {drag ? (
            <div
              className={cn(
                "pointer-events-none inline-flex max-w-[16rem] items-center rounded-full px-3 py-1.5 text-xs font-medium shadow-lg",
                problem
                  ? "cursor-not-allowed bg-grey-10 text-grey-100 dark:bg-grey-light-100 dark:text-black-700"
                  : "bg-primary-50 text-white",
              )}
            >
              <span className="truncate">{dragLabel(drag.items.length, overName, problem)}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <MoveDialog
        items={dialogItems}
        target={target}
        onClose={() => setDialogItems(null)}
        onMove={(destination, destinationName) => {
          const items = dialogItems ?? [];
          setDialogItems(null);
          void moveTo(items, destination, destinationName);
        }}
      />
      <NameClashDialog
        request={clashRequest}
        onDone={(answers) => {
          clashRequest?.resolve(answers);
          setClashRequest(null);
        }}
      />
    </DriveMoveContext.Provider>
  );
}
