"use client";

import { FC } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { GripIcon } from "@/components/ui/icons";
import { Lock, Unlock } from "lucide-react";
import { useStaking } from "@/app/lib/hooks/useStaking";
import { toast } from "sonner";

/* STAKE hALPHA card. Matches the billing-page card chrome.
 *
 * Phase 1 of the wallet redesign wires the surface to existing
 * useStaking data so the bonded balance is real. The Stake Now /
 * Unstake CTAs route through the existing /stake page during this
 * phase — Phase 3 replaces them with dialog-based flows built on
 * WalletDialogShell. */

interface WalletStakeCardProps {
  className?: string;
}

const WalletStakeCard: FC<WalletStakeCardProps> = ({ className }) => {
  const { stakingInfo, isLoading } = useStaking();
  const bonded = stakingInfo?.bondedHip ?? "0";
  const hasBonded =
    !!stakingInfo?.bondedHip && Number(stakingInfo.bondedHip) > 0;

  // Phase-1 placeholder: dialogs land in Phase 3.
  const notReadyToast = () =>
    toast.info("Staking dialogs land in Phase 3 of the wallet redesign.");

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
            Stake hALPHA
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
        {/* Headline stat */}
        <div className="flex items-end justify-start gap-1">
          {isLoading ? (
            <div className="h-[30px] w-[140px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse" />
          ) : (
            <>
              <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white">
                {bonded}
              </span>
              <span className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50 pb-[3px]">
                hALPHA staked
              </span>
            </>
          )}
        </div>

        <p className="text-[12px] font-medium leading-4 tracking-[-0.24px] text-grey-60 dark:text-grey-dark-600">
          Stake your hAlpha tokens on Hippius to earn rewards.
        </p>

        {/* Stake / Unstake actions */}
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="primary"
            size="auto"
            className="h-[36px] rounded-[8px] text-[13px] font-medium tracking-[-0.26px] gap-[7px]"
            onClick={notReadyToast}
          >
            <Lock className="size-3.5 shrink-0" />
            Stake Now
          </Button>
          <Button
            variant="defaultStable"
            size="auto"
            className="h-[36px] rounded-[8px] text-[13px] font-medium tracking-[-0.26px] gap-[7px]"
            onClick={notReadyToast}
            disabled={!hasBonded}
          >
            <Unlock className="size-3.5 shrink-0" />
            Unstake hAlpha
          </Button>
        </div>
      </div>
    </div>
  );
};

export default WalletStakeCard;
