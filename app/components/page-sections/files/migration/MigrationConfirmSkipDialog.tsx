"use client";

import * as Dialog from "@radix-ui/react-dialog";
import React, { useState } from "react";
import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton, Graphsheet, Icons, Input } from "@/components/ui";

export interface MigrationConfirmSkipDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  fileCount: number;
}

const MigrationConfirmSkipDialog: React.FC<MigrationConfirmSkipDialogProps> = ({
  open,
  onClose,
  onConfirm,
  fileCount,
}) => {
  const [confirmText, setConfirmText] = useState("");
  const isConfirmValid = confirmText.toUpperCase() === "DELETE";

  const handleConfirm = () => {
    if (isConfirmValid) {
      onConfirm();
      setConfirmText("");
    }
  };

  const handleClose = () => {
    setConfirmText("");
    onClose();
  };

  return (
    <Dialog.Root open={open}>
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[450px] h-fit" preventClose>
        <Dialog.Title className="sr-only">Confirm Skip Migration</Dialog.Title>

        <div className="px-4 py-6 flex flex-col gap-5">
          <div className="flex flex-col items-center text-center gap-3">
            <div className="size-14 flex justify-center items-center relative">
              <Graphsheet
                majorCell={{
                  lineColor: [239, 68, 68, 1.0],
                  lineWidth: 2,
                  cellDim: 200,
                }}
                minorCell={{
                  lineColor: [248, 113, 113, 1.0],
                  lineWidth: 1,
                  cellDim: 20,
                }}
                className="absolute w-full h-full duration-500 opacity-30 z-0"
              />
              <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
              <div className="h-8 w-8 bg-error-50 rounded-lg flex items-center justify-center z-20">
                <Icons.OctagonAlert className="size-5 text-white" />
              </div>
            </div>
            <h2 className="text-xl font-semibold text-grey-10">Are you sure?</h2>
            <p className="text-sm text-grey-50 max-w-sm">
              This will permanently skip migrating your <strong className="text-grey-30">{fileCount} files</strong> from S3 to Arion.
              They won&apos;t appear in your Hippius Drive.
            </p>
          </div>

          {/* Warning Box */}
          <div className="bg-error-50/10 border border-error-50/30 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Icons.OctagonAlert className="size-5 text-error-50 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-grey-30">
                <p className="font-medium text-error-50 mb-1">This action cannot be undone</p>
                <p className="text-xs text-grey-50">
                  Your files will not be deleted from S3, but you&apos;ll need to manually
                  re-upload them if you want them in your Hippius Drive later.
                </p>
              </div>
            </div>
          </div>

          {/* Confirmation Input */}
          <div>
            <label className="block text-sm font-medium text-grey-40 mb-2">
              Type <span className="font-bold text-grey-20">&quot;DELETE&quot;</span> to confirm:
            </label>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Type DELETE"
              className="w-full"
              autoFocus
            />
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3">
            <CardButton
              variant="secondary"
              className="flex-1 h-12 text-base font-medium border border-grey-80"
              onClick={handleClose}
            >
              Cancel
            </CardButton>
            <CardButton
              variant="error"
              className="flex-1 h-12 text-base font-medium"
              onClick={handleConfirm}
              disabled={!isConfirmValid}
            >
              Confirm Skip
            </CardButton>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
};

export default MigrationConfirmSkipDialog;
