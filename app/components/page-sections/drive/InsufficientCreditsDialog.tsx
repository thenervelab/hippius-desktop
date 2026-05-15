"use client";
import React from "react";
import { useAtom } from "jotai";
import { AlertCircle } from "lucide-react";

import {
  insufficientCreditsDialogOpenAtom,
  InsufficientCreditsReason,
} from "./atoms/query-atoms";
import { Button } from "@/components/ui";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { cn } from "@/lib/utils";
import { openLinkByKey } from "@/app/lib/utils/links";

const copy: Record<
  InsufficientCreditsReason,
  { title: string; description: string }
> = {
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

  const handleClose = () => setReason(false);

  const handleOpenConsoleBillingPage = () => {
    setReason(false);
    openLinkByKey("BILLING");
  };
  const handleOpenConsoleCreditsPage = () => {
    setReason(false);
    openLinkByKey("CREDITS");
  };

  return (
    <FramedDialog
      open={!!reason}
      onClose={handleClose}
      title={title}
      icon={<AlertCircle className="size-5 text-white" />}
      maxWidth="max-w-[653px]"
    >
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        {description}
      </p>

      <div className="flex flex-col gap-3">
        <Button
          variant="primary"
          size="auto"
          onClick={handleOpenConsoleCreditsPage}
          className={cn(
            "h-[52px] w-full rounded-[6px] border text-base font-normal tracking-[-0.36px]",
            "border-[#3167DD] bg-[#3167DD] text-white",
            "hover:bg-[#2454c4] hover:border-[#2454c4]",
            "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]",
          )}
        >
          Buy Credits
        </Button>
        <Button
          variant="defaultStable"
          size="auto"
          onClick={handleOpenConsoleBillingPage}
          className="h-[52px] w-full rounded-[6px] text-base font-normal tracking-[-0.36px]"
        >
          Subscribe
        </Button>
      </div>
    </FramedDialog>
  );
};

export default InsufficientCreditsDialog;
