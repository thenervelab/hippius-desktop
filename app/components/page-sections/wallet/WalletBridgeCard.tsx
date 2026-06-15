"use client";

import { FC, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { BridgeFlow, BridgeArrows } from "@/components/ui/icons";

import BridgeDialog from "./BridgeDialog";

interface WalletBridgeCardProps {
  className?: string;
  /** Optional callback fired after a bridge submission succeeds — used
   *  by parents that render the bridge history table next to this card
   *  so the table can refetch alongside the in-hook cache update. */
  onBridgeSubmitted?: () => void;
}

const WalletBridgeCard: FC<WalletBridgeCardProps> = ({
  className,
  onBridgeSubmitted,
}) => {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <div
        className={cn(
          "flex flex-col items-center w-full h-[205px] rounded-[8px] border overflow-hidden",
          "bg-grey-light-300 border-grey-dark-100",
          "dark:bg-black-primary-bg dark:border-black-300",
          "shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]",
          className,
        )}
      >
        {/* Header */}
        <div className="flex h-[38px] w-full items-center pl-[14px] pr-[10px]">
          <div className="flex items-center gap-1">
            <BridgeFlow className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
            <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
              Bridge Tokens
            </p>
          </div>
        </div>

        {/* Inner panel — Figma 4045:125558 */}
        <div
          className={cn(
            "flex flex-col w-full flex-1 justify-between gap-3",
            "rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
            "bg-[#fbfbfb] dark:bg-black-600 dark:border-black-300",
            "p-3",
          )}
        >
          {/* Figma spec: Geist Mono 12 / 500 / -0.48 tracking, #111
              at 50% opacity, line-height normal. */}
          <p className="font-mono font-medium text-[12px] leading-[normal] tracking-[-0.48px] text-[#111] opacity-50 dark:text-white">
            Transfer tokens between alpha and TAO easily on Hippius
          </p>

          <Button
            variant="defaultStable"
            size="auto"
            // Figma 4045:125561: white surface, grey border, grey text —
            // the same secondary chip treatment we use for the WalletSettings
            // Import button. !-overrides win against defaultStable's
            // bg-grey-90 so the chip stays white-on-white-card.
            className={cn(
              "h-[36px] w-full rounded-[8px] gap-[7px]",
              "text-[13px] font-medium tracking-[-0.26px]",
              "!bg-white !text-[#4f4f4f] border border-grey-dark-100 hover:!bg-grey-light-700",
              "dark:!bg-black-600 dark:!text-grey-light-100 dark:border-black-300 dark:hover:!bg-black-500",
            )}
            onClick={() => setDialogOpen(true)}
          >
            <BridgeArrows className="size-4 shrink-0" />
            Bridge Tokens
          </Button>
        </div>
      </div>

      <BridgeDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSuccess={onBridgeSubmitted}
      />
    </>
  );
};

export default WalletBridgeCard;
