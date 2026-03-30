"use client";

import React from "react";
import { CardButton } from "@/components/ui";
import DialogContainer from "@/components/ui/DialogContainer";
import { PauseCircle } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { DialogIconHeader } from "./DialogIconHeader";

interface PauseSyncDialogProps {
  open: boolean;
  folderName: string | undefined;
  isPausing: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function PauseSyncDialog({
  open,
  folderName,
  isPausing,
  onClose,
  onConfirm,
}: PauseSyncDialogProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !isPausing) onClose();
      }}
    >
      <DialogContainer
        className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[26.75rem] h-fit"
        preventClose={isPausing}
      >
        <Dialog.Title className="sr-only">Pause Sync</Dialog.Title>

        <div className="px-4 py-6 flex flex-col gap-5">
          <div className="flex flex-col items-center text-center gap-3">
            <DialogIconHeader
              icon={<PauseCircle className="size-5 text-grey-100" />}
              bgColor="bg-grey-40"
            />
            <div className="flex flex-col gap-1">
              <h2 className="text-xl font-semibold text-grey-10">
                Pause Sync
              </h2>
              <p className="text-sm text-grey-50 max-w-sm">
                This will pause syncing for &quot;
                <span className="font-semibold text-grey-10">
                  {folderName}
                </span>
                &quot;. No new changes will be uploaded or downloaded until you
                resume.
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <CardButton
              className="w-full"
              variant="secondary"
              onClick={onClose}
              disabled={isPausing}
            >
              Cancel
            </CardButton>
            <CardButton
              className="w-full"
              variant="primary"
              onClick={onConfirm}
              disabled={isPausing}
              loading={isPausing}
            >
              {isPausing ? "Pausing..." : "Pause Sync"}
            </CardButton>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
}
