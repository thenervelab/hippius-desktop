"use client";

import React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import PlanChip from "@/components/ui/plan-chip";
import { WalletMinimal } from "@/components/ui/icons";
import { useStaking } from "@/app/lib/hooks/useStaking";
import { WALLET_FEATURE_ENABLED } from "@/app/lib/featureFlags";
import { cn } from "@/app/lib/utils";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  className?: string;
  hideStats?: boolean;
  infoTooltip?: React.ReactNode;
}

const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  className,
  hideStats = false,
  infoTooltip,
}) => {
  // The global page header reads the auth account's stake so the
  // number stays stable across pages. Per-active-wallet stake belongs
  // on the wallet page itself, not on Overview / Drive / Billing.
  const { stakingInfo, isLoading: isStakingLoading } = useStaking("auth");

  const stakedDisplay = stakingInfo?.bondedHip ?? "—";

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3.5 px-3 py-3 flex-wrap",
        "shadow-[0px_1px_0px_0px_white] dark:shadow-[0px_1px_0px_0px_rgba(255,255,255,0.03)]",
        className,
      )}
    >
      {/* Left: title + optional subtitle */}
      <div className="flex flex-col gap-0.5 pl-1">
        <div className="flex gap-2">
          <h1 className="text-[24px] font-medium leading-8 text-grey-10 dark:text-white">
            {title}
          </h1>
          {infoTooltip && (
            <div className="animate-fade-in-from-b-0.3 opacity-0 flex items-center shrink-0">
              {infoTooltip}
            </div>
          )}
        </div>
        {subtitle && (
          <p
            className="text-[16px] font-medium leading-[22px] text-grey-50 dark:text-[#7D7D7D]"
            style={{ letterSpacing: "-0.32px" }}
          >
            {subtitle}
          </p>
        )}
      </div>

      {/* ─── Right: Wallet + Active Plan card — ~40% of header ─── */}
      {!hideStats && (
        <div
          className={cn(
            "hidden xl:flex items-stretch rounded-lg overflow-hidden",
            WALLET_FEATURE_ENABLED
              ? "min-w-[480px] bg-[#F3F3F3] dark:bg-[#1E1E1E] border border-[#F4F4F4] dark:border-[#313131]"
              : // Wallet feature off: only the Active Plan cell remains, so the
                // card is content-sized and matches the compact Active-Plan box
                // on the Billing header (home/PageHeader's wallet-off layout).
                "w-fit border border-grey-light-500 bg-grey-light-600 dark:border-black-300 dark:bg-black-primary-bg",
          )}
        >
          {/* Wallet cell — 60% of card width. Hidden with the wallet feature
              (its Stake button links to the gated /wallet page); the Active
              Plan cell then becomes the card's only content. */}
          {WALLET_FEATURE_ENABLED && (
            <div className="flex flex-[3] items-center justify-between gap-4 px-4 py-3 border-r border-[#E3E3E3] dark:border-[#161616]">
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1 mb-0.5">
                  <WalletMinimal className="size-[18px] text-primary-50 dark:text-primary-brand-dark" />
                  <span className="font-geist-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark">
                    Wallet
                  </span>
                </div>
                {isStakingLoading ? (
                  <div className="flex items-center gap-1">
                    <Loader2 className="size-3 animate-spin text-primary-50 dark:text-primary-brand-dark" />
                    <span className="text-[12px] font-medium text-grey-10 dark:text-white">
                      Loading...
                    </span>
                  </div>
                ) : (
                  <p className="whitespace-nowrap text-[12px] font-bold leading-[18px] tracking-[-0.12px] tabular-nums text-primary-50 dark:text-primary-brand-dark">
                    {stakedDisplay} hAlpha
                    <span className="text-[12px] font-medium text-grey-10 dark:text-white">
                      {" "}
                      staked
                    </span>
                  </p>
                )}
              </div>
              <Button
                asLink
                variant="primaryLight"
                size="auto"
                href="/dashboard/wallet"
                className="px-4 py-2 text-[14px] font-medium leading-[1.109] tracking-[-0.28px]"
              >
                Stake
              </Button>
            </div>
          )}

          {/* Active Plan cell — 40% of card width when the wallet cell is
              present; the sole, content-sized cell when the wallet feature
              is off. */}
          <div
            className={cn(
              "flex flex-col items-start justify-center py-3",
              WALLET_FEATURE_ENABLED ? "flex-[2] pl-4 pr-5" : "px-4",
            )}
          >
            {/* Shared chip: plan → credits → none, decided by
                get_storage_overview.source — identical to the home header
                and the home cards, with a skeleton until it settles. */}
            <PlanChip />
          </div>
          <div className="flex items-center pr-4">
            <Button
              asLink
              href="/drive-plans"
              variant="raised"
              size="auto"
              className="px-4 py-2 text-[14px] font-medium leading-[1.109] tracking-[-0.28px]"
            >
              Subscriptions
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default PageHeader;
