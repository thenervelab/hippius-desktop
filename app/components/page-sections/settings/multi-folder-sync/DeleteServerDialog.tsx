"use client";

import React from "react";
import { Link2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useAtomValue } from "jotai";
import { driveTrashEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { DELETE_DRIVE_LINKS_ACTION, DELETE_DRIVE_LINKS_NOTE, deleteDriveCopy } from "./deleteDriveCopy";

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
  const trashEnabled = useAtomValue(driveTrashEnabledAtom);
  const copy = deleteDriveCopy(trashEnabled);
  const router = useRouter();
  const openSharedLinks = () => {
    if (isDeletingServer) return;
    onClose();
    router.push("/shares");
  };

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title={copy.title}
      icon={<Trash2 className="size-5 text-white" />}
      maxWidth="max-w-[680px]"
      iconBgClassName="bg-[#fc7d73]"
      borderClassName="bg-[#fc7d73]"
    >
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        {copy.lead}
        <span className="font-semibold text-grey-10 dark:text-white">
          &quot;{folderName}&quot;
        </span>
        {copy.tail}
      </p>
      {/* The share links point in its own quiet card, so it reads apart from
          what the delete does instead of trailing it as a loose paragraph. */}
      <div
        className="mb-5 flex items-start gap-2.5 rounded-lg border border-grey-80 bg-grey-light-200 px-3 py-2.5 text-left text-sm text-[#7D7D7D] dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-dark-600"
        data-testid="delete-drive-links-note"
      >
        <Link2 className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p className="min-w-0">
          {DELETE_DRIVE_LINKS_NOTE}{" "}
          <button
            type="button"
            onClick={openSharedLinks}
            disabled={isDeletingServer}
            className="whitespace-nowrap font-medium text-primary-50 hover:underline focus-visible:underline focus-visible:outline-none disabled:opacity-50 dark:text-primary-brand-dark"
          >
            {DELETE_DRIVE_LINKS_ACTION}
          </button>
        </p>
      </div>

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
            {isDeletingServer ? "Deleting..." : copy.button}
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
}
