"use client";

import React from "react";
import { useRouter } from "next/navigation";
import FramedDialog from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { Icons } from "@/components/ui";

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

  // A pending transition error means "migrated, but sync setup failed" — the
  // dismiss path clears that state instead of the normal close/navigate flow.
  const handleClose = () => {
    if (transitionError) {
      onDismiss?.();
      return;
    }
    onClose();
  };

  const handleAction = () => {
    if (transitionError) {
      onDismiss?.();
      return;
    }
    onClose();
    if (migrationSucceeded) {
      router.push("/files");
    }
  };

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title={migrationSucceeded ? "Migration Complete!" : "Migration Failed"}
      icon={
        migrationSucceeded ? (
          <Icons.TickCircle className="size-5 text-white" />
        ) : (
          <Icons.CloseCircle className="size-5 text-white" />
        )
      }
      iconBgClassName={migrationSucceeded ? "bg-success-50" : "bg-[#fc7d73]"}
      borderClassName={migrationSucceeded ? "bg-success-50" : "bg-[#fc7d73]"}
      maxWidth="max-w-[640px]"
    >
      <p className="mb-5 text-center text-sm leading-5 text-grey-50 dark:text-grey-dark-700">
        {migrationSucceeded
          ? "All your files have been successfully migrated to Hippius Drive."
          : "The migration could not be completed. Please try again later."}
      </p>

      {/* Stats */}
      <div className="mb-5 grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-grey-80 bg-grey-95/60 p-4 text-center dark:border-[#2c2c2c] dark:bg-[#1f1f1f]/60">
          <p className="text-2xl font-bold text-grey-10 dark:text-white">
            {totalCount}
          </p>
          <p className="text-xs text-grey-50 dark:text-grey-dark-700">
            Total Files
          </p>
        </div>
        <div className="rounded-lg border border-success-50/30 bg-success-50/10 p-4 text-center dark:border-success-50/30 dark:bg-success-50/[0.12]">
          <p className="text-2xl font-bold text-success-50">{successCount}</p>
          <p className="text-xs text-grey-50 dark:text-grey-dark-700">
            Migrated
          </p>
        </div>
      </div>

      {/* Transition error banner */}
      {transitionError && (
        <div className="mb-5 rounded-lg border border-warning-50/40 bg-warning-50/10 p-3 dark:border-warning-50/35 dark:bg-warning-50/[0.12]">
          <p className="mb-1 text-xs font-medium text-warning-50">
            Sync setup failed
          </p>
          <p className="text-xs leading-5 text-grey-40 dark:text-grey-dark-700">
            Your files were migrated successfully but sync could not be
            initialized. You can set it up later from Settings.
          </p>
        </div>
      )}

      {/* Action */}
      <Button
        variant="primary"
        size="auto"
        className="h-12 w-full rounded-md text-base font-medium"
        disabled={isTransitioning}
        onClick={handleAction}
      >
        {migrationSucceeded ? "Go to My Files" : "Close"}
      </Button>
    </FramedDialog>
  );
};

export default MigrationCompleteDialog;
