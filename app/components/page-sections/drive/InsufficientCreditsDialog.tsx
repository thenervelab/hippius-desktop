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
import { BILLING_ROUTE } from "@/app/lib/routes";
import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { getUploadBlockReason } from "./uploadRoomState";

type StorageDialogCopy = {
  title: string;
  description: string;
  primaryLabel: string;
  needsPlan: boolean;
};

const upgradeCopy: Record<
  Exclude<InsufficientCreditsReason, "vm-creation">,
  StorageDialogCopy
> = {
  "file-upload": {
    title: "Not enough storage",
    description:
      "This file would go past the storage your plan includes. Upgrade your plan for more room, or remove some files to free space.",
    primaryLabel: "Upgrade",
    needsPlan: true,
  },
  "folder-upload": {
    title: "Not enough storage",
    description:
      "This folder would go past the storage your plan includes. Upgrade your plan for more room, or remove some files to free space.",
    primaryLabel: "Upgrade",
    needsPlan: true,
  },
  "folder-sync": {
    title: "Not enough storage",
    description:
      "Syncing this folder would go past the storage your plan includes. Upgrade your plan for more room, or pick a smaller folder.",
    primaryLabel: "Upgrade",
    needsPlan: true,
  },
  // A share link uploads a re-encrypted copy of the file, and the server
  // bills that copy like any upload — so a refusal here means THIS share
  // does not fit, the same as an upload of the same size would not.
  sharing: {
    title: "Not enough storage",
    description:
      "Sharing this file would go past the storage your plan includes. Upgrade your plan for more room, or free some space.",
    primaryLabel: "Upgrade",
    needsPlan: true,
  },
};

const subscribeCopy: StorageDialogCopy = {
  title: "No storage plan",
  description:
    "Your account has no storage plan, so nothing can be uploaded yet. Subscribe to a plan to get storage — your existing files stay available.",
  primaryLabel: "Subscribe",
  needsPlan: true,
};

const vmCopy: StorageDialogCopy = {
  title: "Not enough balance for VM creation",
  description:
    "Creating a virtual machine needs at least $10 on your account balance. Top up before proceeding.",
  primaryLabel: "Subscribe",
  needsPlan: false,
};

function resolveCopy(
  reason: InsufficientCreditsReason,
  isNoPlan: boolean,
): StorageDialogCopy {
  if (reason === "vm-creation") return vmCopy;
  if (isNoPlan) return subscribeCopy;
  return upgradeCopy[reason];
}

const InsufficientCreditsDialog: React.FC = () => {
  const [reason, setReason] = useAtom(insufficientCreditsDialogOpenAtom);
  const router = useRouter();
  const { data: overview } = useStorageOverview();
  // Prefer Overview's no-plan signal so an access-key account is asked to
  // Subscribe, not Upgrade — the same distinction the banner already makes.
  const isNoPlan =
    getUploadBlockReason(overview) === "no-plan" ||
    overview?.source === "none";

  if (!reason) return null;

  const { title, description, needsPlan, primaryLabel } = resolveCopy(
    reason,
    isNoPlan,
  );

  const handleClose = () => setReason(false);

  const handlePrimary = () => {
    setReason(false);
    if (needsPlan) {
      // The desktop has its own Subscription Plans page — keep the user in
      // the app instead of bouncing them out to the console.
      router.push(BILLING_ROUTE);
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
          {needsPlan ? primaryLabel : "Subscribe"}
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
            Top up
          </Button>
        )}
      </div>
    </FramedDialog>
  );
};

export default InsufficientCreditsDialog;
