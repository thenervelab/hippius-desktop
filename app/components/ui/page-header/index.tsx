"use client";

import React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WalletMinimal } from "@/components/ui/icons";
import { useStaking } from "@/app/lib/hooks/useStaking";
import useSubscriptionData from "@/app/lib/hooks/useSubscriptionData";
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
  const { stakingInfo, isLoading: isStakingLoading } = useStaking();

  const { activeSubscription, isLoading: isSubLoading } = useSubscriptionData();

  const hasActivePlan = !isSubLoading && !!activeSubscription?.has_subscription;

  const stakedDisplay = stakingInfo?.bondedHip ?? "—";

  const storageDisplay = (() => {
    if (isSubLoading || !activeSubscription?.has_subscription) return null;
    const sub = activeSubscription.subscription;
    return sub.storage_limit ?? sub.plan_name ?? "—";
  })();

  const planPrice = (() => {
    if (isSubLoading || !activeSubscription?.has_subscription) return null;
    const sub = activeSubscription.subscription;
    if (sub.amount == null) return null;
    return `$${sub.amount}/${sub.interval === "month" ? "mo." : sub.interval}`;
  })();

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
        <div className="hidden xl:flex min-w-[480px] items-stretch rounded-lg bg-[#F3F3F3] dark:bg-[#1E1E1E] border border-[#F4F4F4] dark:border-[#313131] overflow-hidden">
          {/* Wallet cell — 60% of card width */}
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
                <p className="text-[12px] font-bold leading-[18px] tracking-[-0.36px] text-primary-50 dark:text-primary-brand-dark">
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

          {/* Active Plan cell — 40% of card width */}
          <div className="flex flex-[2] flex-col items-start justify-center gap-0.5 pl-4 pr-5 py-3">
            <div className="flex items-center gap-1 mb-0.5">
              <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-primary-40/20 size-4">
                <span className="rounded-full size-[6.15px] bg-primary-40" />
              </span>
              <span className="font-geist-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark">
                Active Plan
              </span>
            </div>
            {hasActivePlan && storageDisplay ? (
              <p className="text-[12px] font-bold leading-[18px] tracking-[-0.36px] text-primary-50 dark:text-primary-brand-dark">
                {storageDisplay}
                {planPrice && (
                  <span className="text-[12px] font-medium text-grey-10 dark:text-white">
                    {" "}
                    ({planPrice})
                  </span>
                )}
              </p>
            ) : (
              <p className="text-[12px] font-medium leading-[18px] tracking-[-0.24px] text-grey-10 dark:text-grey-dark-700">
                No active plan
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default PageHeader;
