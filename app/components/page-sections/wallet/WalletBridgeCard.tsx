"use client";

import { FC } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { GripIcon, GitCompareArrows } from "@/components/ui/icons";
import { toast } from "sonner";

// Bridge IPCs aren't built yet (dual-chain work, scoped separately);
// the card surface ships now so the wallet page reads as the final
// shape, but the CTA only toasts.
interface WalletBridgeCardProps {
  className?: string;
}

const WalletBridgeCard: FC<WalletBridgeCardProps> = ({ className }) => {
  return (
    <div
      className={cn(
        "flex flex-col items-center w-full rounded-[8px] border overflow-hidden",
        "bg-grey-light-300 border-grey-dark-100",
        "dark:bg-black-primary-bg dark:border-black-300",
        "shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]",
        className,
      )}
    >
      {/* Header */}
      <div className="flex h-[46px] w-full items-center pl-[14px] pr-[10px]">
        <div className="flex items-center gap-1">
          <GripIcon className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
          <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
            Bridge Tokens
          </p>
        </div>
      </div>

      {/* Inner panel */}
      <div
        className={cn(
          "flex flex-col w-full flex-1 justify-between gap-3",
          "rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
          "bg-white dark:bg-black-600 dark:border-black-300",
          "p-3",
        )}
      >
        <div className="flex items-end justify-start gap-1">
          <span className="font-mono font-medium text-[18px] leading-[24px] tracking-[-0.36px] text-grey-10 dark:text-white">
            ALPHA &harr; hALPHA
          </span>
        </div>

        <p className="text-[13px] font-medium leading-[18px] tracking-[-0.26px] text-grey-60 dark:text-grey-dark-600">
          Transfer tokens between Hippius and Bittensor networks easily.
        </p>

        <Button
          variant="primary"
          size="auto"
          className="h-[36px] w-full rounded-[8px] text-[13px] font-medium tracking-[-0.26px] gap-[7px]"
          onClick={() => toast.info("Bridge is coming soon.")}
        >
          <GitCompareArrows className="size-3.5 shrink-0" />
          Bridge Tokens
        </Button>
      </div>
    </div>
  );
};

export default WalletBridgeCard;
