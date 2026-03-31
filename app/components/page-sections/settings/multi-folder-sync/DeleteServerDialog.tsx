"use client";

import React from "react";
import { Icons, CardButton, Input } from "@/components/ui";
import DialogContainer from "@/components/ui/DialogContainer";
import * as Dialog from "@radix-ui/react-dialog";
import { Label } from "@/components/ui/label";
import { DialogIconHeader } from "./DialogIconHeader";

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
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !isDeletingServer) onClose();
      }}
    >
      <DialogContainer
        className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[26.75rem] h-fit"
        preventClose={isDeletingServer}
      >
        <Dialog.Title className="sr-only">
          Delete Folder from Server
        </Dialog.Title>

        <div className="px-4 py-6 flex flex-col gap-5">
          {/* Centered icon header */}
          <div className="flex flex-col items-center text-center gap-3">
            <DialogIconHeader
              icon={<Icons.Trash className="size-6 text-grey-100" />}
              bgColor="bg-error-50"
            />
            <h2 className="text-xl font-semibold text-grey-10">
              Delete Folder from Server
            </h2>
            <p className="text-sm text-grey-50 max-w-sm">
              This will permanently delete all files for &quot;
              <span className="font-semibold text-grey-10">{folderName}</span>
              &quot; from the server. This action cannot be undone.
            </p>
          </div>

          {/* Type name to confirm */}
          <div className="space-y-2 text-left">
            <Label
              htmlFor="delete-confirm"
              className="text-sm font-medium text-grey-30"
            >
              Type the folder name to confirm:
            </Label>
            <Input
              id="delete-confirm"
              placeholder={folderName}
              value={confirmInput}
              onChange={(e) => onConfirmInputChange(e.target.value)}
              disabled={isDeletingServer}
              className="border-grey-80 h-12 text-grey-30 w-full bg-white py-3 font-medium text-base rounded-lg"
            />
            {confirmInput.length > 0 && confirmInput !== folderName && (
              <p className="text-xs text-error-50">
                Folder name does not match. Please type &quot;{folderName}&quot;
                exactly.
              </p>
            )}
          </div>

          {/* Buttons */}
          <div className="flex gap-3">
            <CardButton
              className="w-full"
              variant="secondary"
              onClick={onClose}
              disabled={isDeletingServer}
            >
              Cancel
            </CardButton>
            <CardButton
              className="w-full"
              variant="error"
              onClick={onConfirm}
              disabled={confirmInput !== folderName || isDeletingServer}
              loading={isDeletingServer}
            >
              {isDeletingServer ? "Deleting..." : "Delete Permanently"}
            </CardButton>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
}
