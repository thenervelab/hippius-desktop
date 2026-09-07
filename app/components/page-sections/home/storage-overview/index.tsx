"use client";

import React, { useCallback, useRef, useState } from "react";

import { toast } from "sonner";

import { RefreshButton } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { nextSkeletonState } from "@/lib/utils/skeletonGate";
import { cn } from "@/app/lib/utils";

import GripIcon from "../GripIcon";
import {
  formatPercentLabel,
  getCapacitySourceLabel,
  getStorageOverviewView,
  getUsageTone,
  getUsedBytesDisplay,
  type UsageTone,
} from "./storageOverviewState";

/** Fill + label classes per tone; both themes on every branch. */
const TONE_STYLES: Record<UsageTone, { bar: string; label: string }> = {
  ok: {
    bar: "bg-primary-50 dark:bg-primary-brand-dark",
    label: "text-primary-50 dark:text-primary-brand-dark",
  },
  warn: {
    bar: "bg-warning-50 dark:bg-warning-50",
    label: "text-warning-40 dark:text-warning-50",
  },
  critical: {
    bar: "bg-error-50 dark:bg-error-50",
    label: "text-error-40 dark:text-error-50",
  },
};

/**
 * The simple storage card: bytes used against the effective capacity —
 * the subscription plan's allowance, or the free tier's when there is no
 * plan. The decision comes from Rust (`get_storage_overview.source`); the
 * footer names the source so the free allowance is never mistaken for a
 * paid plan.
 */
const StorageOverviewCard: React.FC<{ className?: string }> = ({
  className,
}) => {
  const {
    data: overview,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useStorageOverview();

  // Skeleton latches to the FIRST settle and never re-shows on background
  // refetches (poll cadence), mirroring the old cards' anti-flicker gate.
  const settledRef = useRef(false);
  const gate = nextSkeletonState(settledRef.current, isLoading);
  settledRef.current = gate.settled;

  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    if (isRefreshing || isFetching) return;
    setIsRefreshing(true);
    try {
      await refetch();
      toast.success("Storage refreshed successfully!");
    } catch (error) {
      console.error("Failed to refresh storage:", error);
      toast.error("Failed to refresh storage");
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, isFetching, refetch]);

  const view = getStorageOverviewView({
    showSkeleton: gate.showSkeleton,
    isError,
    source: overview?.source,
  });

  const percent = overview?.percent ?? 0;
  const tone = getUsageTone(percent);
  const toneStyle = TONE_STYLES[tone];
  const usedDisplay = overview
    ? getUsedBytesDisplay(overview.usedPending, overview.usedBytes)
    : null;

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
      <div className="flex h-[46px] w-full items-center justify-center">
        <div className="flex flex-1 min-w-0 items-center justify-between pl-[14px] pr-[10px] py-2">
          <div className="flex items-center gap-1">
            <GripIcon className="size-[18px] text-primary-40 dark:text-primary-brand-dark" />
            <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
              Storage
            </p>
          </div>
          <RefreshButton
            onClick={handleRefresh}
            refetching={isRefreshing}
            ariaLabel="Refresh storage"
          />
        </div>
      </div>

      <div
        className={cn(
          "flex flex-col items-start w-full flex-1 rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
          "bg-white",
          "dark:bg-black-600 dark:border-black-300",
        )}
      >
        <div className="flex w-full flex-1 flex-col justify-center gap-3 px-4 py-4">
          {view === "skeleton" && (
            <>
              <div className="flex items-center justify-between">
                <div
                  className="h-[30px] w-[180px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
                  aria-label="Loading storage"
                />
                <div
                  className="h-[30px] w-[56px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
                  aria-hidden="true"
                />
              </div>
              <div
                className="h-[10px] w-full rounded-full bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
                aria-hidden="true"
              />
            </>
          )}

          {view === "error" && (
            // A failed fetch must NOT read as a real "0 B of 0 B" (the same
            // rule as the old credits card, audit M-16).
            <div className="flex flex-col items-start gap-1">
              <p className="font-mono font-medium text-[16px] leading-[24px] text-grey-10 dark:text-white">
                Couldn&apos;t load storage
              </p>
              <p className="text-[13px] font-medium leading-[18px] text-grey-50 dark:text-grey-dark-500">
                Check your connection and refresh to try again.
              </p>
            </div>
          )}

          {view === "no-plan" && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col items-start gap-1">
                <p className="font-mono font-medium text-[16px] leading-[24px] text-grey-10 dark:text-white">
                  No storage available
                </p>
                <p className="text-[13px] font-medium leading-[18px] text-grey-50 dark:text-grey-dark-500">
                  Subscribe to a plan to get Drive storage.
                </p>
              </div>
              <Button
                asLink
                href="/billing"
                variant="primaryLight"
                size="auto"
                className="px-4 py-2 text-[14px] font-medium leading-[1.109] tracking-[-0.28px]"
              >
                Get Storage
              </Button>
            </div>
          )}

          {view === "usage" && overview && (
            <>
              <div className="flex items-end justify-between gap-3">
                <div className="flex items-end gap-1 min-w-0">
                  <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white">
                    {usedDisplay?.kind === "pending"
                      ? "Updating…"
                      : overview.usedDisplay}
                  </span>
                  <span className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50 pb-[3px] whitespace-nowrap">
                    of {overview.totalDisplay} used
                  </span>
                </div>
                <span
                  className={cn(
                    "font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] whitespace-nowrap",
                    toneStyle.label,
                  )}
                >
                  {formatPercentLabel(percent)}
                </span>
              </div>

              <div
                role="progressbar"
                aria-valuenow={Math.round(percent)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Storage used"
                className="h-[10px] w-full overflow-hidden rounded-full bg-grey-light-700 dark:bg-grey-dark-200"
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-[width] duration-500",
                    toneStyle.bar,
                  )}
                  style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <p className="text-[12px] font-medium leading-[18px] text-grey-50 dark:text-grey-dark-500 truncate">
                  {getCapacitySourceLabel(overview.source, overview.plan?.name)}
                </p>
                <p className="text-[12px] font-medium leading-[18px] text-grey-50 dark:text-grey-dark-500 whitespace-nowrap">
                  {overview.freeDisplay} free
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default StorageOverviewCard;
