"use client";

import React, { useCallback, useRef, useState } from "react";

import { toast } from "sonner";

import { RefreshButton } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { nextSkeletonState } from "@/lib/utils/skeletonGate";
import { cn } from "@/app/lib/utils";

import GripIcon from "../GripIcon";
import { BILLING_ROUTE } from "@/app/lib/routes";
import {
  getUsageAsideLabel,
  getCapacitySourceLabel,
  getPlanView,
  getStorageOverviewView,
  getUsageTone,
  getUsedBytesDisplay,
  NO_PLAN_DESCRIPTION,
  NO_PLAN_TITLE,
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

  // The same decision the Plan card made, from the same fetch: a held plan
  // is managed, the free tier is upgraded. Anything else (error, unknown
  // source) offers nothing rather than guessing at a route.
  const planView = getPlanView({
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
        // Its OWN container. The `@md:` inside this card would otherwise
        // measure the page's scroll wrapper, so in a third-width column on a
        // wide window the card would still lay the figure, the percent and
        // the button out in one row and cram all three. Measuring itself is
        // what lets the same card sit full width or in a third of one.
        "@container",
        "flex flex-col items-center w-full rounded-[8px] border overflow-hidden",
        "bg-grey-light-300 border-grey-dark-100",
        "dark:bg-black-primary-bg dark:border-black-300",
        "shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]",
        className,
      )}
    >
      {/* `min-h-[52px]` matches the breakdown card's header beside it, which
          is sized by its tab control. The two headers have to agree or the
          pair reads as misaligned at the top of the row, which is the one
          place a mismatch is most visible. */}
      <div className="flex min-h-[52px] w-full items-center gap-2 py-2 pl-[14px] pr-[10px]">
        <GripIcon className="size-[18px] shrink-0 text-primary-40 dark:text-primary-brand-dark" />
        <p className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark">
          Storage
        </p>
        {/* Refresh sits inboard of the action: the action is the thing being
            reached for, so it takes the outer edge. */}
        <RefreshButton
          onClick={handleRefresh}
          refetching={isRefreshing}
          ariaLabel="Refresh storage"
        />
        {/* The plan action lives up here now. In the body it shared a row
            with the figure and the bar, which is what forced that row to
            reflow at narrow widths; the header has space it was not using. */}
        {planView === "plan" || planView === "free" ? (
          <Button
            asLink
            href={BILLING_ROUTE}
            variant={planView === "plan" ? "defaultStable" : "primaryLight"}
            size="auto"
            className="h-[30px] shrink-0 px-3 text-[13px] font-medium leading-[1.109] tracking-[-0.26px]"
          >
            {planView === "plan" ? "Manage" : "Upgrade"}
          </Button>
        ) : null}
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
                  className="h-[30px] w-[180px] rounded bg-grey-80 dark:bg-grey-dark-200 animate-pulse"
                  aria-label="Loading storage"
                />
                <div
                  className="h-[30px] w-[56px] rounded bg-grey-80 dark:bg-grey-dark-200 animate-pulse"
                  aria-hidden="true"
                />
              </div>
              <div
                className="h-[10px] w-full rounded-full bg-grey-80 dark:bg-grey-dark-200 animate-pulse"
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

          {/* No capacity at all.

              Quiet, and shaped like the Plan card's own empty state
              beside it — a line, a sentence, a button — because the red
              banner above the pair already carries the alarm and the
              reason. Two earlier versions each put the whole message in
              here instead: first as a paragraph, then as a red "0 B"
              over a full red bar. The bar was the worse of the two. A
              full bar means "you have used all of your storage", and
              this account has none to use, so the one graphic on the
              card stated something that was not true — and painting the
              page's only progress bar solid red made a state the user
              can fix in two clicks read as a fault. */}
          {view === "no-plan" && (
            <div className="flex flex-wrap items-center justify-between gap-3 w-full">
              <div className="flex flex-col items-start gap-1">
                <p className="font-mono font-medium text-[16px] leading-[24px] text-grey-10 dark:text-white">
                  {NO_PLAN_TITLE}
                </p>
                <p className="text-[13px] font-medium leading-[18px] text-grey-50 dark:text-grey-dark-500">
                  {NO_PLAN_DESCRIPTION}
                </p>
              </div>
              <Button
                asLink
                href={BILLING_ROUTE}
                variant="primaryLight"
                size="auto"
                className="px-4 py-2 text-[14px] font-medium leading-[1.109] tracking-[-0.28px]"
              >
                Get Storage
              </Button>
            </div>
          )}

          {/* The action lives in this card now, beside the reading it acts
              on, which is the shape the console's storage card already
              uses. It used to sit on a second card that restated the plan
              name and allowance this one was already showing, so the pair
              said one thing twice and the button was the only part of the
              second card that was not a repeat.

              Which action, from the same `get_storage_overview` source as
              the reading: a held plan is managed, the free tier is
              upgraded. `getPlanView` is the helper that card used, so the
              two surfaces cannot drift apart. */}
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
                  {getUsageAsideLabel({
                    percent,
                    overDisplay: overview.overDisplay,
                  })}
                </span>
              </div>

              <div
                role="progressbar"
                aria-valuenow={Math.round(percent)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Storage used"
                // See the plan chip: the `grey-light-*` family is all
                // #f0–f3, invisible on this white card, so the groove used
                // the same token as the card itself.
                className="h-[10px] w-full overflow-hidden rounded-full bg-grey-80 dark:bg-grey-dark-200"
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
