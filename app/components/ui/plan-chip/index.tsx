"use client";

import React, { useRef } from "react";

import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";

import { nextSkeletonState } from "@/lib/utils/skeletonGate";
import { cn } from "@/app/lib/utils";
import {
  getPlanView,
  getUsageTone,
  shouldShowUsageBar,
  type UsageTone,
} from "@/app/components/page-sections/home/storage-overview/storageOverviewState";

/**
 * Bar fill per tone, matching the home storage card's own scale so the two
 * cannot describe the same account differently.
 *
 * The tone comes from the shared `getUsageTone` rather than a second
 * threshold here: brand under 80%, amber from 80% (where Rust also starts
 * offering Upgrade), red from 95%.
 */
const BAR_TONE: Record<UsageTone, string> = {
  ok: "bg-primary-50 dark:bg-primary-brand-dark",
  warn: "bg-warning-50 dark:bg-warning-50",
  critical: "bg-error-50 dark:bg-error-50",
};

/**
 * The top-header plan/credits chip, shared by every page header that shows
 * the "Active Plan" cell (home `PageHeader`, the global `ui/page-header`
 * used by Files / VM / Notifications).
 *
 * Renders from the SAME `get_storage_overview` fetch as the home cards, so
 * the plan-vs-free-tier decision (made once, in Rust) is identical on every
 * surface:
 *
 *   - subscription → heading "Active Plan", value "≈ 1 TB  (12$/mo.)"
 *   - no plan      → heading "Free Plan",   value "≈ 10.00 GB  included"
 *   - unknown      → heading "Active Plan", value "No active plan"
 *
 * The heading itself waits for the decision: a skeleton holds BOTH lines
 * until the query settles, so the chip never flashes "No active plan" (or
 * the wrong heading) while loading.
 *
 * A slim usage bar sits under the value on both the plan and free-tier
 * branches. The words alone ("2.82 GB of 10.00 GB used") make the reader
 * do the arithmetic to find out whether that is comfortable or nearly
 * full, which is the one thing the header is there to answer.
 */
const PlanChip: React.FC<{ className?: string }> = ({ className }) => {
  const {
    data: overview,
    isLoading,
    isError,
  } = useStorageOverview();

  const settledRef = useRef(false);
  const gate = nextSkeletonState(settledRef.current, isLoading);
  settledRef.current = gate.settled;

  const planView = getPlanView({
    showSkeleton: gate.showSkeleton,
    isError,
    source: overview?.source,
  });
  const plan = overview?.plan ?? null;

  const percent = overview?.percent ?? 0;
  const tone = getUsageTone(percent);
  const showUsageBar = shouldShowUsageBar(planView);

  return (
    <div className={cn("flex flex-col items-start justify-center gap-0.5", className)}>
      <div className="flex items-center gap-1">
        <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-primary-40/20">
          <span className="size-[6.15px] rounded-full bg-primary-40" />
        </span>
        {planView === "skeleton" ? (
          <span
            className="h-[18px] w-[72px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
            aria-label="Loading plan"
          />
        ) : (
          <span className="font-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark">
            {planView === "free" ? "Free Plan" : "Active Plan"}
          </span>
        )}
      </div>
      {planView === "skeleton" ? (
        <span
          className="h-[18px] w-[112px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
          aria-hidden="true"
        />
      ) : planView === "plan" && plan ? (
        /* On a plan, what matters is how much of it is left — the price is
           already known to someone who chose it, and the free tier's line
           below sells the allowance instead. */
        <p className="whitespace-pre text-[12px] font-bold leading-[18px] tracking-[-0.36px] text-primary-50 dark:text-primary-brand-dark">
          {overview?.usedDisplay ?? ""}
          <span className="text-[12px] font-medium text-black-700 dark:text-white">
            {"  "}of {plan.storageDisplay} used
          </span>
        </p>
      ) : planView === "free" ? (
        <p className="whitespace-pre text-[12px] font-bold leading-[18px] tracking-[-0.36px] text-primary-50 dark:text-primary-brand-dark">
          ≈ {overview?.totalDisplay ?? ""}
          <span className="text-[12px] font-medium text-black-700 dark:text-white">
            {"  "}included
          </span>
        </p>
      ) : (
        <p className="text-[12px] font-medium leading-[18px] tracking-[-0.24px] text-black-700 dark:text-grey-dark-500">
          No active plan
        </p>
      )}
      {showUsageBar && (
        <div
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Storage used"
          /* self-stretch, so the bar is exactly as wide as the longest
             line above it rather than needing a width nobody can keep in
             step with the copy. */
          className="mt-1 h-[4px] w-full self-stretch overflow-hidden rounded-full bg-grey-light-700 dark:bg-grey-dark-200"
        >
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", BAR_TONE[tone])}
            style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }}
          />
        </div>
      )}
    </div>
  );
};

export default PlanChip;
