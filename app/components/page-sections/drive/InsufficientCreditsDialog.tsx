"use client";
import React from "react";
import { useAtom } from "jotai";
import { useRouter } from "next/navigation";
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
  { title: string; description: string; needsPlan: boolean }
> = {
  "file-upload": {
    title: "Not enough storage",
    description:
      "This file would go past the storage your plan includes. Upgrade your plan for more room, or remove some files to free space.",
    needsPlan: true,
  },
  "folder-upload": {
    title: "Not enough storage",
    description:
      "This folder would go past the storage your plan includes. Upgrade your plan for more room, or remove some files to free space.",
    needsPlan: true,
  },
  "folder-sync": {
    title: "Not enough storage",
    description:
      "Syncing this folder would go past the storage your plan includes. Upgrade your plan for more room, or pick a smaller folder.",
    needsPlan: true,
  },
  // VM creation is genuinely credit-priced and keeps the credits route.
  "vm-creation": {
    title: "Insufficient Credits for VM Creation",
    description:
      "You need at least 10 credits to create a virtual machine. Please add credits before proceeding.",
    needsPlan: false,
  },
};

const InsufficientCreditsDialog: React.FC = () => {
  const [reason, setReason] = useAtom(insufficientCreditsDialogOpenAtom);
  const router = useRouter();

  if (!reason) return null;

  const { title, description, needsPlan } = copy[reason];

  const handleClose = () => setReason(false);

  const handlePrimary = () => {
    setReason(false);
    if (needsPlan) {
      // The desktop has its own Subscription Plans page — keep the user in
      // the app instead of bouncing them out to the console.
      router.push("/drive-plans");
      return;
    }
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
        {/* Storage is sold as a plan, so a bigger plan is the only way out
            of a full drive. Credits buy no Drive storage and offering them
            here would send the user somewhere that cannot help. */}
        <Button
          variant="primary"
          size="auto"
          onClick={handlePrimary}
          className={cn(
            "h-[52px] w-full rounded-[6px] border text-base font-normal tracking-[-0.36px]",
            "border-[#3167DD] bg-[#3167DD] text-white",
            "hover:bg-[#2454c4] hover:border-[#2454c4]",
            "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]",
          )}
        >
          {needsPlan ? "View plans" : "Subscribe"}
        </Button>
        {needsPlan ? (
          <Button
            variant="defaultStable"
            size="auto"
            onClick={handleClose}
            className="h-[52px] w-full rounded-[6px] text-base font-normal tracking-[-0.36px]"
          >
            Not now
          </Button>
        ) : (
          <Button
            variant="defaultStable"
            size="auto"
            onClick={handleOpenConsoleCreditsPage}
            className="h-[52px] w-full rounded-[6px] text-base font-normal tracking-[-0.36px]"
          >
            Buy Credits
          </Button>
        )}
      </div>
    </FramedDialog>
  );
};

export default InsufficientCreditsDialog;
