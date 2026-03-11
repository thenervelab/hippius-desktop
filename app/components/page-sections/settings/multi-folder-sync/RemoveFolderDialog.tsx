"use client";

import React from "react";
import { CardButton } from "@/components/ui";
import DialogContainer from "@/components/ui/DialogContainer";
import { Trash2 } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { DialogIconHeader } from "./DialogIconHeader";

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
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !isRemoving) onClose();
      }}
    >
      <DialogContainer
        className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit"
        preventClose={isRemoving}
      >
        <Dialog.Title className="sr-only">
          Remove Folder from Sync
        </Dialog.Title>

        <div className="px-4 py-6 flex flex-col gap-5">
          <div className="flex flex-col items-center text-center gap-3">
            <DialogIconHeader
              icon={<Trash2 className="size-5 text-grey-100" />}
              bgColor="bg-error-50"
            />
            <div className="flex flex-col gap-1">
              <h2 className="text-xl font-semibold text-grey-10">
                Remove Folder from Sync
              </h2>
              <p className="text-sm text-grey-50 max-w-sm">
                Are you sure you want to remove &quot;
                <span className="font-semibold text-grey-10">
                  {folderName}
                </span>
                &quot; from sync? Local files will remain on your device, but
                this folder will no longer be synchronized.
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <CardButton
              className="w-full"
              variant="secondary"
              onClick={onClose}
              disabled={isRemoving}
            >
              Cancel
            </CardButton>
            <CardButton
              className="w-full"
              variant="error"
              onClick={onConfirm}
              disabled={isRemoving}
              loading={isRemoving}
            >
              {isRemoving ? "Removing..." : "Remove Folder"}
            </CardButton>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
}
