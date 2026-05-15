import React from "react";
import { ArrowRight, Trash2 } from "lucide-react";

import { useFileSelection } from "@/app/contexts/FileSelectionContext";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DeleteConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (filesToDelete: FormattedUserFile[]) => void;
  isLoading?: boolean;
}

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
    <FramedDialog
      open={open}
      onClose={handleCancel}
      title={heading}
      icon={<Trash2 className="size-[18px] text-white" strokeWidth={2.5} />}
      borderClassName={DESTRUCTIVE_BG}
      iconBgClassName={DESTRUCTIVE_BG}
      maxWidth="max-w-[585px]"
      cardClassName="bg-white dark:bg-[#161616]"
      contentClassName="sm:w-[405px]"
    >
      <div className="font-geist">
        <p className="mb-4 text-center text-base font-medium leading-[22px] tracking-[-0.32px] text-grey-20 dark:text-grey-dark-700">
          Are you sure you want to delete{" "}
          {isMultiple ? `these ${fileCount} files` : "this file"}? This action
          cannot be undone.
        </p>

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

        <Button
          variant="destructive"
          className="h-[52px] w-full text-white"
          onClick={handleConfirm}
          disabled={isLoading || fileCount === 0}
          loading={isLoading}
        >
          {confirmLabel}
          {!isLoading && <ArrowRight className="ml-1.5 size-4" />}
        </Button>

        <Button
          className={cn(
            "mt-3 h-[52px] w-full border border-[#e3e3e3] bg-transparent text-grey-10",
            "hover:bg-grey-90",
            "dark:border-[#494949] dark:bg-transparent dark:text-white dark:hover:bg-[#2c2c2c]",
          )}
          onClick={handleCancel}
          disabled={isLoading}
        >
          Cancel
        </Button>
      </div>
    </FramedDialog>
  );
};

export default DeleteConfirmationDialog;
