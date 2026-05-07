"use client";

import * as Dialog from "@radix-ui/react-dialog";
import React from "react";
import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton, Graphsheet, Icons } from "@/components/ui";
import { useRouter } from "next/navigation";

export interface MigrationCompleteDialogProps {
  open: boolean;
  onClose: () => void;
  successCount: number;
  totalCount: number;
  migrationSucceeded: boolean;
  transitionError?: string | null;
  onDismiss?: () => void;
  /** When true, the transition is in progress — disables the action button to prevent double-invocation. */
  isTransitioning?: boolean;
}

const MigrationCompleteDialog: React.FC<MigrationCompleteDialogProps> = ({
  open,
  onClose,
  successCount,
  totalCount,
  migrationSucceeded,
  transitionError,
  onDismiss,
  isTransitioning,
}) => {
  const router = useRouter();

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && (transitionError ? onDismiss?.() : onClose())}>
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[28.125rem] h-fit">
        <Dialog.Title className="sr-only">Migration Complete</Dialog.Title>

        <div className="px-4 py-6 flex flex-col gap-5">
          <div className="flex flex-col items-center text-center gap-3">
            <div className="size-14 flex justify-center items-center relative">
              <Graphsheet
                majorCell={{
                  lineColor: migrationSucceeded ? [34, 197, 94, 1.0] : [239, 68, 68, 1.0],
                  lineWidth: 2,
                  cellDim: 200,
                }}
                minorCell={{
                  lineColor: migrationSucceeded ? [74, 222, 128, 1.0] : [248, 113, 113, 1.0],
                  lineWidth: 1,
                  cellDim: 20,
                }}
                className="absolute w-full h-full duration-500 opacity-30 z-0"
              />
              <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
              <div className={`h-8 w-8 rounded-lg flex items-center justify-center z-20 ${
                migrationSucceeded ? "bg-success-50" : "bg-error-50"
              }`}>
                {migrationSucceeded ? (
                  <Icons.TickCircle className="size-5 text-white" />
                ) : (
                  <Icons.CloseCircle className="size-5 text-white" />
                )}
              </div>
            </div>
            <h2 className="text-xl font-semibold text-grey-10">
              {migrationSucceeded ? "Migration Complete!" : "Migration Failed"}
            </h2>
            <p className="text-sm text-grey-50 max-w-sm">
              {migrationSucceeded
                ? "All your files have been successfully migrated to Hippius Drive."
                : "The migration could not be completed. Please try again later."}
            </p>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-grey-95 border border-grey-80 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-grey-20">{totalCount}</p>
              <p className="text-xs text-grey-50">Total Files</p>
            </div>
            <div className="bg-success-50/10 border border-success-50/30 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-success-50">{successCount}</p>
              <p className="text-xs text-grey-50">Migrated</p>
            </div>
          </div>

          {/* Transition Error Banner */}
          {transitionError && (
            <div className="bg-warning-50/10 border border-warning-50/30 rounded-lg p-3">
              <p className="text-xs font-medium text-warning-50 mb-1">
                Sync setup failed
              </p>
              <p className="text-xs text-grey-40">
                Your files were migrated successfully but sync could not be
                initialized. You can set it up later from Settings.
              </p>
            </div>
          )}

          {/* Action Button */}
          <CardButton
            variant="primary"
            className="w-full h-12 text-base font-medium"
            disabled={isTransitioning}
            onClick={() => {
              if (transitionError) {
                onDismiss?.();
              } else {
                onClose();
                if (migrationSucceeded) {
                  router.push("/files");
                }
              }
            }}
          >
            {migrationSucceeded ? "Go to My Files" : "Close"}
          </CardButton>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
};

export default MigrationCompleteDialog;
