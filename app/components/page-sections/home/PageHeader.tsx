"use client";

import { FC, ReactNode, useEffect, useMemo, useState } from "react";
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

interface PageHeaderProps {
  title?: string;
  subtitle?: string;
  infoButton?: ReactNode;
  showTopUpCredits?: boolean;
  /** When provided, replaces the default right-side block (Wallet +
   * Active Plan chips + Top-up button) with the supplied node. Used by
   * the wallet page to slot in the ActiveWalletSelector instead. */
  rightSlot?: ReactNode;
}

const PageHeader: FC<PageHeaderProps> = ({
  title = "Welcome to Hippius",
  subtitle = "Store. Compute. Own your infrastructure.",
  infoButton,
  showTopUpCredits = true,
  rightSlot,
}) => {
  // Auth-account stake — see the comment in `useStaking` on why the
  // home / billing / overview headers read the auth account rather
  // than the active local wallet.
  const { stakingInfo } = useStaking("auth");
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
    // Title and wallet card sit side-by-side (each ~50%) at @4xl+; the card
    // fills its half — the three sections are balanced WITHIN it via the
    // flex-grow/basis below, not by letting the card grow to full width.
    // gap-4 (not 3) so the card's left edge aligns with the right column of
    // the home page's `gap-4 @xl:grid-cols-2` charts grid directly below.
    // Very-wide-viewport elongation is handled by the page-level content cap
    // in ResponsiveContent, not here.
    <div className="grid grid-cols-1 @4xl:grid-cols-[1fr_1fr] items-stretch gap-4 mt-3">
      <div className="flex flex-col items-start justify-center gap-0.5 px-1">
        <div className="flex items-center gap-2">
          <p className="text-[24px] font-medium leading-8 text-black-700 dark:text-white">
            {title}
          </p>
          {infoButton}
        </div>
        <p className="text-[16px] font-medium leading-[22px] tracking-[-0.32px] text-grey-dark-800">
          {subtitle}
        </p>
      </div>

      {rightSlot ? (
        <div className="flex items-center justify-end">{rightSlot}</div>
      ) : (
      <div
        className={cn(
          "flex items-stretch rounded-[8px]",
          "border border-grey-light-500 bg-grey-light-600",
          "dark:border-black-300 dark:bg-black-primary-bg",
          showTopUpCredits ? "gap-3.5 px-3.5" : "px-0",
        )}
      >
        <div className="flex flex-1 min-w-0 items-stretch">
          {/* Wallet section. The 14px left inset comes from the outer wrapper's
              `px-3.5` when the top-up button is shown; only add our own `pl-3.5`
              when that wrapper has none (`px-0`), so the staked text never ends
              up double-padded (28px) instead of the intended 14px. */}
          <div
            className={cn(
              // Big flex-basis (240px) + modest grow so the wallet keeps the
              // weight on narrow cards; on wide cards it still grows but slower
              // than the active-plan column (which has a bigger grow), so they
              // converge instead of the wallet hogging every extra pixel.
              "flex flex-[2_1_240px] min-w-0 items-center justify-between gap-3 border-r border-grey-dark-100 dark:border-black-500 pr-5 py-[11px]",
              showTopUpCredits ? "" : "pl-3.5",
            )}
          >
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
                <p className="whitespace-nowrap text-[12px] font-bold leading-[18px] tracking-[-0.12px] tabular-nums text-primary-50 dark:text-primary-brand-dark">
                  {stakedDisplay} hAlpha
                  <span className="ml-1 text-[12px] font-medium text-black-700 dark:text-white">
                    staked
                  </span>
                </p>
              )}
            </div>
            <Button
              asLink
              href="/wallet"
              variant="primaryLight"
              size="auto"
              className="px-4 py-2 text-[14px] font-medium leading-[1.109] tracking-[-0.28px]"
            >
              Stake
            </Button>
          </div>

          {/* Active plan section — border-r only when top-up button is visible.
              Smaller flex-basis than the wallet section (its content — label +
              short plan string — is narrow) but a HIGHER grow, so the wallet
              keeps the weight on small cards while this column catches up on
              wide ones. `min-w-[150px]` keeps the label from clipping. */}
          <div
            className={cn(
              "flex flex-[3_1_150px] min-w-[150px] flex-col items-start justify-center gap-[3px] py-[11px] dark:border-black-500",
              showTopUpCredits
                ? "border-r border-grey-dark-100 px-5"
                : "pl-5 pr-3.5",
            )}
          >
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

        {showTopUpCredits && (
          <div className="flex shrink-0 items-center py-[11px]">
            <Button
              asLink
              href="/billing"
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
        )}
      </div>
      )}
    </div>
  );
};

export default PageHeader;
