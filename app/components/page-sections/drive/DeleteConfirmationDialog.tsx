import React from "react";
import { Trash2 } from "lucide-react";

import ConfirmationDialog from "@/app/components/ConfirmationDialog";
import { useFileSelection } from "@/app/contexts/FileSelectionContext";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

interface DeleteConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (filesToDelete: FormattedUserFile[]) => void;
  isLoading?: boolean;
}

/**
 * Drive-specific delete confirm.
 *
 * Owns the FileSelection -> filesToDelete mapping and the multi-file
 * bullet-list rendering; defers all chrome (FramedDialog frame, coral
 * destructive pill, ghost cancel) to the canonical `ConfirmationDialog`
 * so style fixes propagate everywhere from one component.
 */
const DESTRUCTIVE_BG = "bg-[#fc7d73]";

const DeleteConfirmationDialog: React.FC<DeleteConfirmationDialogProps> = ({
  open,
  onOpenChange,
  onConfirm,
  isLoading = false,
}) => {
  const { selectedFiles, clearSelection } = useFileSelection();

  const handleCancel = () => {
    if (isLoading) return;
    onOpenChange(false);
    clearSelection();
  };

  const handleConfirm = () => {
    const filesToDelete = [...selectedFiles];
    clearSelection();
    onOpenChange(false);
    onConfirm(filesToDelete);
  };

  const fileCount = selectedFiles.length;
  const isMultiple = fileCount > 1;
  const heading = isMultiple ? "Delete Files" : "Delete File";
  const confirmLabel = isLoading
    ? "Deleting..."
    : `Delete ${isMultiple ? "Files" : "File"}`;

  return (
    <ConfirmationDialog
      open={open}
      onClose={handleCancel}
      onBack={handleCancel}
      onConfirm={handleConfirm}
      heading={heading}
      text={
        <>
          Are you sure you want to delete{" "}
          {isMultiple ? `these ${fileCount} files` : "this file"}? This action
          cannot be undone.
        </>
      }
      button={confirmLabel}
      icon={<Trash2 className="size-[18px] text-white" strokeWidth={2.5} />}
      iconBgColor={DESTRUCTIVE_BG}
      confirmVariant="destructive"
      disableButton={isLoading || fileCount === 0}
      disableBackButton={isLoading}
    >
      {selectedFiles.length > 0 && (
        <div className="mb-6 max-h-32 overflow-y-auto rounded-md border border-grey-80 bg-grey-95/40 px-3 py-2 dark:border-[#2c2c2c] dark:bg-[#1f1f1f]/60">
          <div className="mb-1.5 text-xs font-medium text-grey-50 dark:text-grey-dark-600">
            Files to delete:
          </div>
          <ul className="space-y-1 text-sm">
            {selectedFiles.slice(0, 5).map((file, index) => (
              <li
                key={
                  file.arionHash ||
                  `${file.actualFileName || file.name}-${index}`
                }
                className="truncate text-grey-20 dark:text-grey-dark-800"
              >
                • {file.actualFileName || file.name}
              </li>
            ))}
            {selectedFiles.length > 5 && (
              <li className="text-xs text-grey-50 dark:text-grey-dark-600">
                ... and {selectedFiles.length - 5} more
              </li>
            )}
          </ul>
        </div>
      )}
    </ConfirmationDialog>
  );
};

export default DeleteConfirmationDialog;
