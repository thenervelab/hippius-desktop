"use client";

import React, { useState } from "react";
import FramedDialog from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { Icons, Input } from "@/components/ui";

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
    <FramedDialog
      open={open}
      onClose={handleClose}
      title="Are you sure?"
      icon={<Icons.OctagonAlert className="size-5 text-white" />}
      iconBgClassName="bg-[#fc7d73]"
      borderClassName="bg-[#fc7d73]"
      maxWidth="max-w-[640px]"
    >
      <p className="mb-5 text-center text-sm leading-5 text-grey-50 dark:text-grey-dark-700">
        This will permanently skip migrating your{" "}
        <strong className="font-semibold text-grey-10 dark:text-white">
          {fileCount} files
        </strong>{" "}
        from S3 to Arion. They won&apos;t appear in your Hippius Drive.
      </p>

      {/* Irreversible-action warning */}
      <div className="mb-5 flex items-start gap-3 rounded-lg border border-[#fc7d73]/30 bg-[#fc7d73]/10 p-4 dark:border-[#fc7d73]/30 dark:bg-[#fc7d73]/[0.12]">
        <Icons.OctagonAlert className="mt-0.5 size-5 shrink-0 text-[#d6453a] dark:text-[#fc7d73]" />
        <div>
          <p className="mb-1 text-sm font-semibold text-[#d6453a] dark:text-[#fc7d73]">
            This action cannot be undone
          </p>
          <p className="text-xs leading-5 text-grey-30 dark:text-grey-dark-700">
            Your files will not be deleted from S3, but you&apos;ll need to
            manually re-upload them if you want them in your Hippius Drive later.
          </p>
        </div>
      </div>

      {/* Type-to-confirm */}
      <div className="mb-5">
        <label className="mb-2 block text-sm font-medium text-grey-40 dark:text-grey-dark-700">
          Type{" "}
          <span className="font-bold text-grey-20 dark:text-white">
            &quot;DELETE&quot;
          </span>{" "}
          to confirm:
        </label>
        <Input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="Type DELETE"
          autoFocus
        />
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <Button
          variant="defaultStable"
          size="auto"
          className="h-12 flex-1 rounded-md text-base font-medium"
          onClick={handleClose}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="auto"
          className="h-12 flex-1 rounded-md text-base font-medium text-white"
          onClick={handleConfirm}
          disabled={!isConfirmValid}
        >
          Confirm Skip
        </Button>
      </div>
    </FramedDialog>
  );
};

export default MigrationConfirmSkipDialog;
