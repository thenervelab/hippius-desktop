"use client";

import React from "react";
import { PauseCircle } from "lucide-react";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

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
  const handleClose = () => {
    if (isPausing) return;
    onClose();
  };

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title="Pause Sync"
      icon={<PauseCircle className="size-5 text-white" />}
      maxWidth="max-w-[480px]"
      iconBgClassName="bg-[#3167dd]"
    >
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        This will pause syncing for{" "}
        <span className="font-semibold text-grey-10 dark:text-white">
          &quot;{folderName}&quot;
        </span>
        . No new changes will be uploaded or downloaded until you resume.
      </p>

      <div className="flex gap-3">
        <Button
          variant="defaultStable"
          size="auto"
          onClick={handleClose}
          disabled={isPausing}
          className="h-[42px] w-full rounded-[6px] text-sm font-medium"
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          size="auto"
          onClick={onConfirm}
          disabled={isPausing}
          loading={isPausing}
          className={cn(
            "h-[42px] w-full rounded-[6px] border text-sm font-medium",
            "border-[#3167DD] bg-[#3167DD] text-white",
            "hover:bg-[#2454c4] hover:border-[#2454c4]",
            "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
          )}
        >
          {isPausing ? "Pausing..." : "Pause Sync"}
        </Button>
      </div>
    </FramedDialog>
  );
}
