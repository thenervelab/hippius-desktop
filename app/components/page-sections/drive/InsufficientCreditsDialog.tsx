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
import { getUploadBlockDialogCopy } from "./uploadBlockCopy";

type DialogCopy = {
  title: string;
  description: string;
  primaryLabel: string;
  needsPlan: boolean;
};

const vmCopy: DialogCopy = {
  title: "Not enough balance for VM creation",
  description:
    "Creating a virtual machine needs at least $10 on your account balance. Top up before proceeding.",
  primaryLabel: "Subscribe",
  needsPlan: false,
};

/** Fallback when Overview has not settled but eligibility already refused. */
const genericUpgradeCopy: DialogCopy = {
  title: "Not enough storage",
  description:
    "Uploads are paused, your files stay available. Upgrade or free up space.",
  primaryLabel: "Upgrade",
  needsPlan: true,
};

function resolveCopy(
  reason: InsufficientCreditsReason,
  overviewSource: ReturnType<typeof useStorageOverview>["data"],
): DialogCopy {
  if (reason === "vm-creation") return vmCopy;

  const block = getUploadBlockReason(overviewSource);
  if (block) {
    const copy = getUploadBlockDialogCopy(block, overviewSource?.source);
    return { ...copy, needsPlan: true };
  }

  // Live eligibility refused without an Overview block (rare race). Prefer
  // over-quota wording: files stay, no 30-day deletion clock.
  return genericUpgradeCopy;
}

const InsufficientCreditsDialog: React.FC = () => {
  const [reason, setReason] = useAtom(insufficientCreditsDialogOpenAtom);
  const router = useRouter();
  const { data: overview } = useStorageOverview();

  if (!reason) return null;

  const { title, description, needsPlan, primaryLabel } = resolveCopy(
    reason,
    overview,
  );

  const handleClose = () => setReason(false);

  const handlePrimary = () => {
    setReason(false);
    if (needsPlan) {
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
