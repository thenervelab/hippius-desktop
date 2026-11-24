import React, { useState, useEffect } from "react";
import { useAtom, useAtomValue } from "jotai";
import { Button } from "@/components/ui/button/NewButton";
import { useFileSelection } from "@/app/contexts/FileSelectionContext";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { FolderSymlink, MoreHorizontal, Trash2 } from "lucide-react";
import TableActionMenu from "@/components/ui/alt-table/TableActionMenu";
import { rowLabels, useStars } from "@/app/lib/starred/useStars";
import { canStar } from "@/app/lib/starred/starState";
import { starMenuItem } from "@/app/lib/starred/starMenu";
import { useDriveMove } from "./move/DriveMoveProvider";
import { MOVE_DISABLED_TOOLTIP } from "@/app/lib/utils/renameGating";
import DeleteConfirmationDialog from "./DeleteConfirmationDialog";
import { driveTrashEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import {
  deleteForeverPromptAtom,
  deleteLabel,
  resolveDeleteMode,
  useOptionKeyHeld,
  useSkipTrash,
  type DeleteMode,
} from "@/app/lib/trash/deleteMode";
import { trashShortcutHint, useTrashShortcuts } from "@/app/lib/hooks/useTrashShortcuts";

interface SelectionActionBarProps {
  /**
   * `turnOffLinks[i]`: the links to turn off once `files[i]` is deleted.
   * `mode` is `trash` for Move to Trash; anything else deletes for good.
   */
  onDelete: (files: FormattedUserFile[], turnOffLinks?: string[][], mode?: DeleteMode) => void;
  isDeleting?: boolean;
  /**
   * The folder the view shows, for a selected folder that carries only its
   * own name (Star resolves its path against it).
   */
  basePath?: string | null;
}

const SelectionActionBar: React.FC<SelectionActionBarProps> = ({
  onDelete,
  isDeleting = false,
  basePath,
}) => {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const { isSelectionMode, selectedFiles, clearSelection } = useFileSelection();
  // The overflow's Star: "Unstar" once every starrable item in the
  // selection is starred, one request batch and one toast either way.
  const stars = useStars(rowLabels(selectedFiles));
  const starrable = selectedFiles.filter((f) => canStar(f, basePath));
  const selectionStarred = stars.allStarred(starrable, basePath);
  // With Trash on, the button moves to Trash (no confirm, Undo); Option, or
  // the "Skip Trash" setting, makes it Delete forever, which asks first.
  // With Trash off it is today's Delete, word for word.
  const trashEnabled = useAtomValue(driveTrashEnabledAtom);
  const { skipTrash } = useSkipTrash();
  const optionHeld = useOptionKeyHeld();
  const mode = resolveDeleteMode(trashEnabled, skipTrash, optionHeld);
  // Which confirmation is open: frozen when it opens, so releasing Option
  // while it is up does not change what it asks.
  const [dialogForever, setDialogForever] = useState(false);
  const [foreverPrompt, setForeverPrompt] = useAtom(deleteForeverPromptAtom);
  // Move sits beside Delete inside a drive folder, under the Rename gates:
  // offered when every item may be written, enabled when every one is
  // settled.
  const driveMove = useDriveMove();
  const offersMove = Boolean(driveMove) && selectedFiles.length > 0 && selectedFiles.every((f) => driveMove?.offersMove(f));
  const canMove = offersMove && selectedFiles.every((f) => driveMove?.canMove(f));

  // Close dialog when selection is cleared (after successful deletion)
  useEffect(() => {
    if (selectedFiles.length === 0 && showDeleteDialog) {
      setShowDeleteDialog(false);
    }
  }, [selectedFiles.length, showDeleteDialog]);

  const openForever = () => {
    if (selectedFiles.length === 0 || isDeleting) return;
    setDialogForever(true);
    setShowDeleteDialog(true);
  };

  const moveSelectionToTrash = () => {
    if (selectedFiles.length === 0 || isDeleting) return;
    const files = [...selectedFiles];
    clearSelection();
    onDelete(files, undefined, "trash");
  };

  // A menu's "Delete forever" selected its row and asks for the confirm.
  useEffect(() => {
    if (!foreverPrompt || selectedFiles.length === 0) return;
    setForeverPrompt(false);
    setDialogForever(true);
    setShowDeleteDialog(true);
  }, [foreverPrompt, selectedFiles.length, setForeverPrompt]);

  useTrashShortcuts({
    enabled: trashEnabled && selectedFiles.length > 0 && !showDeleteDialog,
    onTrash: () => (skipTrash ? openForever() : moveSelectionToTrash()),
    onForever: openForever,
  });

  // Cmd/Shift-click selects without the mode, and gets the bar too.
  if (!isSelectionMode && selectedFiles.length === 0) {
    return null;
  }

  const handleDeleteClick = () => {
    if (selectedFiles.length === 0) return;
    if (mode === "trash") {
      moveSelectionToTrash();
      return;
    }
    setDialogForever(mode === "forever");
    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = (filesToDelete: FormattedUserFile[], turnOffLinks?: string[][]) => {
    onDelete(filesToDelete, turnOffLinks, dialogForever ? "forever" : "legacy");
    // Don't close dialog here - it will close automatically when selection is cleared after successful deletion
  };

  const handleDialogCancel = (open: boolean) => {
    setShowDeleteDialog(open);
    // Don't clear selection when user cancels dialog
  };

  return (
    <>
      <div className="fixed bottom-8 left-1/2 transform -translate-x-1/2 z-50 w-full max-w-lg">
        <div className="bg-primary-50 text-grey-100 rounded-full shadow-lg px-4 py-2 flex items-center justify-between">
          <div className="font-medium text-sm">
            {selectedFiles.length}{" "}
            {selectedFiles.length === 1 ? "file" : "files"} selected
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={clearSelection}
              className="hover:!text-grey-90 !text-grey-100"
              disabled={isDeleting}
            >
              Cancel
            </Button>
            {offersMove && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => driveMove?.openMoveDialog(selectedFiles)}
                disabled={!canMove || isDeleting}
                title={!canMove ? MOVE_DISABLED_TOOLTIP : undefined}
                className="flex items-center gap-1 hover:!text-grey-90 !text-grey-100"
              >
                <FolderSymlink className="w-4 h-4" />
                <span>Move</span>
              </Button>
            )}
            {starrable.length > 0 && (
              <TableActionMenu
                dropdownTitle=""
                items={[
                  starMenuItem(
                    selectionStarred,
                    () => void stars.toggleRows(starrable, basePath),
                    isDeleting,
                  ),
                ]}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="More actions"
                  title="More actions"
                  disabled={isDeleting}
                  className="flex items-center hover:!text-grey-90 !text-grey-100"
                >
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </TableActionMenu>
            )}
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteClick}
              disabled={selectedFiles.length === 0 || isDeleting}
              className="flex items-center gap-1 whitespace-nowrap hover:!text-error-70 !text-grey-100"
              aria-label={mode === "legacy" ? undefined : deleteLabel(mode)}
              title={mode === "legacy" ? undefined : `${deleteLabel(mode)} (${trashShortcutHint(mode)})`}
            >
              <Trash2 className="w-4 h-4" />
              {/* "Move to Trash" and "Delete forever" are longer than the
                  narrowest window has room for beside Cancel and Move: there
                  the button is its icon, named by its label and tooltip. */}
              <span className={mode === "legacy" ? undefined : "max-sm:hidden"}>
                {isDeleting
                  ? mode === "trash"
                    ? "Moving..."
                    : "Deleting..."
                  : deleteLabel(mode)}
              </span>
            </Button>
          </div>
        </div>
      </div>

      <DeleteConfirmationDialog
        open={showDeleteDialog}
        onOpenChange={handleDialogCancel}
        onConfirm={handleConfirmDelete}
        isLoading={isDeleting}
        forever={dialogForever}
      />
    </>
  );
};

export default SelectionActionBar;
