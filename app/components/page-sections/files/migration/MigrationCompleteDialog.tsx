"use client";

import * as Dialog from "@radix-ui/react-dialog";
import React from "react";
import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton, Graphsheet, Icons } from "@/components/ui";

export interface MigrationCompleteDialogProps {
  open: boolean;
  onClose: () => void;
  successCount: number;
  failedCount: number;
  totalCount: number;
  failedFiles?: Array<{ name: string; error: string }>;
}

const MigrationCompleteDialog: React.FC<MigrationCompleteDialogProps> = ({
  open,
  onClose,
  successCount,
  failedCount,
  totalCount,
  failedFiles = [],
}) => {
  const effectiveFailedCount = Math.max(failedCount, failedFiles.length);
  const isFullSuccess = effectiveFailedCount === 0;
  const isPartialSuccess = successCount > 0 && effectiveFailedCount > 0;

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[450px] h-fit">
        <Dialog.Title className="sr-only">Migration Complete</Dialog.Title>

        <div className="px-4 py-6 flex flex-col gap-5">
          <div className="flex flex-col items-center text-center gap-3">
            <div className="size-14 flex justify-center items-center relative">
              <Graphsheet
                majorCell={{
                  lineColor: isFullSuccess ? [34, 197, 94, 1.0] : isPartialSuccess ? [234, 179, 8, 1.0] : [239, 68, 68, 1.0],
                  lineWidth: 2,
                  cellDim: 200,
                }}
                minorCell={{
                  lineColor: isFullSuccess ? [74, 222, 128, 1.0] : isPartialSuccess ? [250, 204, 21, 1.0] : [248, 113, 113, 1.0],
                  lineWidth: 1,
                  cellDim: 20,
                }}
                className="absolute w-full h-full duration-500 opacity-30 z-0"
              />
              <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
              <div className={`h-8 w-8 rounded-lg flex items-center justify-center z-20 ${
                isFullSuccess ? "bg-success-50" : isPartialSuccess ? "bg-warning-50" : "bg-error-50"
              }`}>
                {isFullSuccess ? (
                  <Icons.TickCircle className="size-5 text-white" />
                ) : isPartialSuccess ? (
                  <Icons.OctagonAlert className="size-5 text-white" />
                ) : (
                  <Icons.CloseCircle className="size-5 text-white" />
                )}
              </div>
            </div>
            <h2 className="text-xl font-semibold text-grey-10">
              {isFullSuccess
                ? "Migration Complete!"
                : isPartialSuccess
                ? "Migration Partially Complete"
                : "Migration Failed"}
            </h2>
            <p className="text-sm text-grey-50 max-w-sm">
              {isFullSuccess
                ? "All your files have been successfully migrated to Hippius Drive."
                : isPartialSuccess
                ? "Some files could not be migrated. You can find them using their IPFS links."
                : "The migration could not be completed. Please try again later."}
            </p>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-grey-95 border border-grey-80 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-grey-20">{totalCount}</p>
              <p className="text-xs text-grey-50">Total Files</p>
            </div>
            <div className="bg-success-50/10 border border-success-50/30 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-success-50">{successCount}</p>
              <p className="text-xs text-grey-50">Migrated</p>
            </div>
            <div
              className={`rounded-lg p-3 text-center ${
                effectiveFailedCount > 0 ? "bg-error-50/10 border border-error-50/30" : "bg-grey-95 border border-grey-80"
              }`}
            >
              <p
                className={`text-2xl font-bold ${
                  effectiveFailedCount > 0 ? "text-error-50" : "text-grey-40"
                }`}
              >
                {effectiveFailedCount}
              </p>
              <p className="text-xs text-grey-50">Failed</p>
            </div>
          </div>

          {/* Failed Files List */}
          {failedFiles.length > 0 && (
            <div className="bg-error-50/5 border border-error-50/20 rounded-lg p-3 max-h-[150px] overflow-y-auto">
              <p className="text-xs font-medium text-error-50 mb-2">Failed Files</p>
              <div className="space-y-2">
                {failedFiles.map((file, index) => (
                  <div key={index} className="flex flex-col gap-0.5">
                    <span className="text-xs text-grey-30 truncate">{file.name}</span>
                    <span className="text-xs text-error-50/70">{file.error}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action Button */}
          <CardButton
            variant="primary"
            className="w-full h-12 text-base font-medium"
            onClick={onClose}
          >
            {isFullSuccess ? "Go to My Files" : "Close"}
          </CardButton>

          {/* Help Text */}
          {effectiveFailedCount > 0 && (
            <p className="text-xs text-grey-60 text-center">
              Failed files can still be accessed via their original IPFS links.
            </p>
          )}
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
};

export default MigrationCompleteDialog;
