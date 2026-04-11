"use client";
import React from "react";
import { useAtom } from "jotai";
import { insufficientCreditsDialogOpenAtom, InsufficientCreditsReason } from "./atoms/query-atoms";
import { Icons, CardButton, AbstractIconWrapper } from "@/components/ui";
import { openLinkByKey } from "@/app/lib/utils/links";

const copy: Record<InsufficientCreditsReason, { title: string; description: string }> = {
  "file-upload": {
    title: "Insufficient Credits for File Upload",
    description:
      "You do not have enough credits to upload a file to Hippius. File upload is paused until your credits are enough.",
  },
  "folder-upload": {
    title: "Insufficient Credits for Folder Upload",
    description:
      "You do not have enough credits to upload a folder to Hippius. Folder upload is paused until your credits are enough.",
  },
  "folder-sync": {
    title: "Insufficient Credits for Folder Sync",
    description:
      "You do not have enough credits to sync this folder. Please add credits before adding a new sync folder.",
  },
  "vm-creation": {
    title: "Insufficient Credits for VM Creation",
    description:
      "You need at least 10 credits to create a virtual machine. Please add credits before proceeding.",
  },
};

const InsufficientCreditsDialog: React.FC = () => {
  const [reason, setReason] = useAtom(insufficientCreditsDialogOpenAtom);

  if (!reason) return null;

  const { title, description } = copy[reason];

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      setReason(false);
    }
  };

  const handleOpenConsoleBillingPage = () => {
    setReason(false);
    openLinkByKey("BILLING");
  };
  const handleOpenConsoleCreditsPage = () => {
    setReason(false);
    openLinkByKey("CREDITS");
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-[60] bg-white/70"
      onClick={handleOverlayClick}
    >
      <div className="bg-white rounded-lg shadow-dialog max-w-[26.75rem] max-h-[85vh] overflow-y-auto w-full p-6 animate-in fade-in border border-grey-80 relative">
        <div className="flex flex-col items-center">
          <AbstractIconWrapper className="size-8 mb-4">
            <Icons.BoxSimple2 className="relative size-5 text-primary-50" />
          </AbstractIconWrapper>

          <h2 className="text-2xl font-medium text-grey-10 text-center">
            {title}
          </h2>

          <p className="mt-3 text-base text-center text-grey-50 mb-6">
            {description}
          </p>

          <div className="flex flex-col w-full gap-y-2">
            <CardButton
              className="w-full"
              onClick={handleOpenConsoleCreditsPage}
            >
              Buy Credits
            </CardButton>

            <CardButton
              variant="secondary"
              className="w-full"
              onClick={handleOpenConsoleBillingPage}
            >
              Subscribe
            </CardButton>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InsufficientCreditsDialog;
