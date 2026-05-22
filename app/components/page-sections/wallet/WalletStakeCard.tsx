"use client";

import { FC, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  StakeIndicator,
  StakeNow,
  UnstakeHalpha,
} from "@/components/ui/icons";
import { ArrowDown } from "lucide-react";
import { useStaking } from "@/app/lib/hooks/useStaking";
import StakeDialog from "./StakeDialog";
import UnstakeDialog from "./UnstakeDialog";
import WithdrawDialog from "./WithdrawDialog";

interface WalletStakeCardProps {
  className?: string;
}

const WalletStakeCard: FC<WalletStakeCardProps> = ({ className }) => {
  const { stakingInfo, isLoading, refetch } = useStaking();
  const bonded = stakingInfo?.bondedHip ?? "0";
  const withdrawable = stakingInfo?.withdrawableHip ?? "0";
  const hasBonded = Number.parseFloat(bonded) > 0;
  const hasWithdrawable = Number.parseFloat(withdrawable) > 0;

  const [stakeOpen, setStakeOpen] = useState(false);
  const [unstakeOpen, setUnstakeOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

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
            <StakeIndicator className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
            <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
              Stake hALPHA
            </p>
          </div>
        </div>

        {/* Inner panel — Figma 4045:125523 */}
        <div
          className={cn(
            "flex flex-col w-full flex-1 justify-between gap-3",
            "rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
            "bg-[#fbfbfb] dark:bg-black-600 dark:border-black-300",
            "p-3",
          )}
        >
          {/* Headline stat — mirrors WalletBalanceCard typography so the
              two top cards read as a pair. Label drops "staked" per
              Figma; the card title already says STAKE so the unit
              alone is enough. */}
          <div className="flex items-end justify-start gap-1">
            {isLoading ? (
              <div className="h-[30px] w-[140px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse" />
            ) : (
              <>
                <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-[#111] dark:text-white">
                  {bonded}
                </span>
                <span className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.48px] text-[#111] opacity-50 dark:text-white pb-[3px]">
                  hAlpha
                </span>
              </>
            )}
          </div>

          {/* Stake / Unstake actions */}
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="primary"
              size="auto"
              className="h-[36px] rounded-[8px] text-[13px] font-medium tracking-[-0.26px] gap-[7px]"
              onClick={() => setStakeOpen(true)}
            >
              <StakeNow className="size-3.5 shrink-0" />
              Stake Now
            </Button>
            <Button
              variant="defaultStable"
              size="auto"
              // Figma 4045:125539: white surface, grey border, grey
              // text. Matches the Bridge Tokens CTA for a consistent
              // secondary read across both lower cards.
              className={cn(
                "h-[36px] rounded-[8px] gap-[7px]",
                "text-[13px] font-medium tracking-[-0.26px]",
                "!bg-white !text-[#4f4f4f] border border-grey-dark-100 hover:!bg-grey-light-700",
                "dark:!bg-black-600 dark:!text-grey-light-100 dark:border-black-300 dark:hover:!bg-black-500",
              )}
              onClick={() => setUnstakeOpen(true)}
              disabled={!hasBonded}
            >
              <UnstakeHalpha className="size-3.5 shrink-0" />
              Unstake hAlpha
            </Button>
          </div>

          {/* Withdraw row — only shown when there's redeemable balance. */}
          {hasWithdrawable && (
            <Button
              variant="primaryLight"
              size="auto"
              className="h-[36px] rounded-[8px] text-[13px] font-medium tracking-[-0.26px] gap-[7px]"
              onClick={() => setWithdrawOpen(true)}
            >
              <ArrowDown className="size-3.5 shrink-0" />
              Withdraw {withdrawable} hALPHA
            </Button>
          )}
        </div>
      </div>

      <StakeDialog
        open={stakeOpen}
        onClose={() => setStakeOpen(false)}
        onSuccess={() => refetch()}
      />
      <UnstakeDialog
        open={unstakeOpen}
        onClose={() => setUnstakeOpen(false)}
        onSuccess={() => refetch()}
      />
      <WithdrawDialog
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        onSuccess={() => refetch()}
      />
    </>
  );
};

export default WalletStakeCard;
