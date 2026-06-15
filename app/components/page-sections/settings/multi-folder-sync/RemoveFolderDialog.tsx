"use client";

import React from "react";
import { Trash2 } from "lucide-react";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

interface RemoveFolderDialogProps {
  open: boolean;
  folderName: string | null;
  isRemoving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function RemoveFolderDialog({
  open,
  folderName,
  isRemoving,
  onClose,
  onConfirm,
}: RemoveFolderDialogProps) {
  const handleClose = () => {
    if (isRemoving) return;
    onClose();
  };

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title="Remove Folder from Sync"
      icon={<Trash2 className="size-5 text-white" />}
      maxWidth="max-w-[680px]"
      iconBgClassName="bg-[#fc7d73]"
    >
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        Are you sure you want to remove{" "}
        <span className="font-semibold text-grey-10 dark:text-white">
          &quot;{folderName}&quot;
        </span>{" "}
        from sync? Local files will remain on your device, but this folder
        will no longer be synchronized.
      </p>

      <div className="flex gap-3">
        <Button
          variant="defaultStable"
          size="auto"
          onClick={handleClose}
          disabled={isRemoving}
          className="h-[42px] w-full rounded-[6px] text-sm font-medium"
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="auto"
          onClick={onConfirm}
          disabled={isRemoving}
          loading={isRemoving}
          className={cn(
            "h-[42px] w-full rounded-[6px] border text-sm font-medium",
            "border-[#fc7d73] bg-[#fc7d73] text-white",
            "hover:bg-[#fb695e] hover:border-[#fb695e]"
          )}
        >
          {isRemoving ? "Removing..." : "Remove Folder"}
        </Button>
      </div>
    </FramedDialog>
  );
}
