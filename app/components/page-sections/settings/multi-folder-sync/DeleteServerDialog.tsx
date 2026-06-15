"use client";

import React from "react";
import { Trash2 } from "lucide-react";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";

interface DeleteServerDialogProps {
  open: boolean;
  folderName: string;
  confirmInput: string;
  isDeletingServer: boolean;
  onConfirmInputChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteServerDialog({
  open,
  folderName,
  confirmInput,
  isDeletingServer,
  onConfirmInputChange,
  onClose,
  onConfirm,
}: DeleteServerDialogProps) {
  const handleClose = () => {
    if (isDeletingServer) return;
    onClose();
  };

  const mismatch = confirmInput.length > 0 && confirmInput !== folderName;

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title="Delete Folder from Server"
      icon={<Trash2 className="size-5 text-white" />}
      maxWidth="max-w-[680px]"
      iconBgClassName="bg-[#fc7d73]"
      borderClassName="bg-[#fc7d73]"
    >
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        This will permanently delete all files for{" "}
        <span className="font-semibold text-grey-10 dark:text-white">
          &quot;{folderName}&quot;
        </span>{" "}
        from the server. This action cannot be undone.
      </p>

      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-grey-40 dark:text-grey-dark-600">
            Type the folder name to confirm:
          </span>
          <Input
            id="delete-confirm"
            placeholder={folderName}
            value={confirmInput}
            onChange={(e) => onConfirmInputChange(e.target.value)}
            disabled={isDeletingServer}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {mismatch && (
          <p className="-mt-2 text-xs text-error-50">
            Folder name does not match. Please type &quot;{folderName}&quot;
            exactly.
          </p>
        )}

        <div className="flex gap-3">
          <Button
            variant="defaultStable"
            size="auto"
            onClick={handleClose}
            disabled={isDeletingServer}
            className="h-[42px] w-full rounded-[6px] text-sm font-medium"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="auto"
            onClick={onConfirm}
            disabled={confirmInput !== folderName || isDeletingServer}
            loading={isDeletingServer}
            className={cn(
              "h-[42px] w-full rounded-[6px] border text-sm font-medium",
              "border-[#fc7d73] bg-[#fc7d73] text-white",
              "hover:bg-[#fb695e] hover:border-[#fb695e]"
            )}
          >
            {isDeletingServer ? "Deleting..." : "Delete Permanently"}
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
}
