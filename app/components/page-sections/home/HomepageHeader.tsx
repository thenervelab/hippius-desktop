"use client";

import { FC, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import { Icons } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/app/lib/utils";
import { useStaking } from "@/app/lib/hooks/useStaking";
import useSubscriptionData from "@/app/lib/hooks/useSubscriptionData";

interface StorageCapacityInfo {
  storageGb: number;
  storageDisplay: string;
  usageDescription: string;
}

const formatHipCompact = (value: string): string => {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  if (num === 0) return "0";

  const abs = Math.abs(num);
  if (abs >= 1_000_000_000)
    return `${(num / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (abs >= 1_000_000)
    return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (abs >= 1) return num.toFixed(2).replace(/\.?0+$/, "");
  return num.toFixed(4).replace(/\.?0+$/, "");
};

const HomepageHeader: FC = () => {
  const { stakingInfo } = useStaking();
  const { activeSubscription, isLoadingActive } = useSubscriptionData();

  const hasActiveSubscription = !!activeSubscription?.has_subscription;
  const currentSubscription = hasActiveSubscription
    ? activeSubscription?.subscription
    : null;

  const [storageDisplay, setStorageDisplay] = useState<string>("");
  useEffect(() => {
    if (!currentSubscription?.credits_per_billing) {
      setStorageDisplay("");
      return;
    }
    invoke<StorageCapacityInfo[]>("calculate_storage_capacity", {
      creditsPerMonth: [currentSubscription.credits_per_billing],
    })
      .then((results) => {
        if (results[0]?.storageDisplay) {
          setStorageDisplay(results[0].storageDisplay);
        }
      })
      .catch(() => setStorageDisplay(""));
  }, [currentSubscription?.credits_per_billing]);

  const stakedDisplay = useMemo(
    () => formatHipCompact(stakingInfo.bondedHip),
    [stakingInfo.bondedHip],
  );

  const planPrice = currentSubscription
    ? `${currentSubscription.amount}$/${
        currentSubscription.interval === "month"
          ? "mo."
          : currentSubscription.interval
      }`
    : "";

  return (
    <div
      className={cn(
        "grid grid-cols-1 @4xl:grid-cols-[1fr_1fr]  items-stretch gap-3 mt-3",
      )}
    >
      <div className="flex flex-col items-start justify-center gap-0.5 px-1">
        <p className="text-[24px] font-medium leading-8 text-black-700 dark:text-white">
          Welcome to Hippius
        </p>
        <p className="text-[16px] font-medium leading-[22px] tracking-[-0.32px] text-grey-dark-800">
          Store. Compute. Own your infrastructure.
        </p>
      </div>

      <div
        className={cn(
          "flex items-stretch gap-3.5 rounded-[8px] px-3.5",
          "border border-grey-light-500 bg-grey-light-600",
          "dark:border-black-300 dark:bg-black-primary-bg",
        )}
      >
        <div className="flex flex-1 min-w-0 items-stretch">
          <div className="flex flex-1 min-w-0 items-center justify-between gap-3 border-r border-grey-dark-100 pr-5 py-[11px] dark:border-black-500">
            <div className="flex flex-col items-start justify-center gap-[3px]">
              <div className="flex items-center gap-1">
                <Icons.Wallet className="size-[18px] text-primary-40 dark:text-primary-brand-dark" />
                <span className="font-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark">
                  Wallet
                </span>
              </div>
              {stakingInfo.isLoading ? (
                <div className="flex items-center gap-1">
                  <Loader2 className="size-3 animate-spin text-primary-50 dark:text-primary-brand-dark" />
                  <span className="text-[12px] font-medium text-grey-10 dark:text-white">
                    Loading...
                  </span>
                </div>
              ) : (
                <p className="whitespace-nowrap text-[12px] font-bold leading-[18px] tracking-[-0.36px] text-primary-50 dark:text-primary-brand-dark">
                  {stakedDisplay} hAlpha
                  <span className="ml-1 text-[12px] font-medium text-black-700 dark:text-white">
                    staked
                  </span>
                </p>
              )}
            </div>
            <Button
              asLink
              href="/stake"
              variant="primaryLight"
              size="auto"
              className="px-4 py-2 text-[14px] font-medium leading-[1.109] tracking-[-0.28px]"
            >
              Stake
            </Button>
          </div>

          <div className="flex w-[200px] flex-col items-start justify-center gap-[3px] border-r border-grey-dark-100 px-5 py-[11px] dark:border-black-500">
            <div className="flex items-center gap-1">
              <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-primary-40/20">
                <span className="size-[6.15px] rounded-full bg-primary-40" />
              </span>
              <span className="font-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark">
                Active Plan
              </span>
            </div>
            {isLoadingActive ? (
              <div className="flex items-center gap-1">
                <Loader2 className="size-3 animate-spin text-primary-50 dark:text-primary-brand-dark" />
                <span className="text-[12px] font-medium text-grey-10 dark:text-white">
                  Loading...
                </span>
              </div>
            ) : hasActiveSubscription && currentSubscription ? (
              <p className="whitespace-pre text-[12px] font-bold leading-[18px] tracking-[-0.36px] text-primary-50 dark:text-primary-brand-dark">
                {storageDisplay || "—"}
                <span className="text-[12px] font-medium text-black-700 dark:text-white">
                  {"  "}({planPrice})
                </span>
              </p>
            ) : (
              <p className="text-[12px] font-medium leading-[18px] tracking-[-0.24px] text-black-700 dark:text-grey-dark-500">
                No active plan
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center py-[11px]">
          <Button
            asLink
            href="/billing/plans"
            variant="defaultStable"
            size="auto"
            className={cn(
              "h-[33px] rounded-[7px] px-[14px] text-[14px] font-medium tracking-[-0.28px]",
              "border border-grey-dark-100 bg-white text-black-600",
              "shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16),0px_1px_0px_0px_white,0px_1px_0px_0px_white]",
              "dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-dark-400",
              "dark:shadow-[0px_0px_0px_1px_black]",
            )}
          >
            + Top up Credits
          </Button>
        </div>
      </div>
    </div>
  );
};

export default HomepageHeader;
