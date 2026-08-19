"use client";

import React, { useRef } from "react";

import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { nextSkeletonState } from "@/lib/utils/skeletonGate";
import { cn } from "@/app/lib/utils";
import {
  formatPlanPrice,
  getPlanView,
} from "@/app/components/page-sections/home/storage-overview/storageOverviewState";

/**
 * The top-header plan/credits chip, shared by every page header that shows
 * the "Active Plan" cell (home `PageHeader`, the global `ui/page-header`
 * used by Files / VM / Notifications).
 *
 * Renders from the SAME `get_storage_overview` fetch as the home cards, so
 * the plan-vs-credits decision (made once, in Rust) is identical on every
 * surface:
 *
 *   - subscription → heading "Active Plan", value "≈ 1 TB  (12$/mo.)"
 *   - credits only → heading "Credits",     value "12.5  credits"
 *   - neither      → heading "Active Plan", value "No active plan"
 *
 * The heading itself waits for the decision: a skeleton holds BOTH lines
 * until the query settles, so the chip never flashes "No active plan" (or
 * the wrong heading) while loading.
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
            {planView === "credits" ? "Credits" : "Active Plan"}
          </span>
        )}
      </div>
      {planView === "skeleton" ? (
        <span
          className="h-[18px] w-[112px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
          aria-hidden="true"
        />
      ) : planView === "plan" && plan ? (
        <p className="whitespace-pre text-[12px] font-bold leading-[18px] tracking-[-0.36px] text-primary-50 dark:text-primary-brand-dark">
          ≈ {formatBytes(plan.storageBytes)}
          <span className="text-[12px] font-medium text-black-700 dark:text-white">
            {"  "}({formatPlanPrice(plan.amount, plan.interval)})
          </span>
        </p>
      ) : planView === "credits" ? (
        <p className="whitespace-pre text-[12px] font-bold leading-[18px] tracking-[-0.36px] text-primary-50 dark:text-primary-brand-dark">
          {overview?.creditsHip ?? "0"}
          <span className="text-[12px] font-medium text-black-700 dark:text-white">
            {"  "}credits
          </span>
        </p>
      ) : (
        <p className="text-[12px] font-medium leading-[18px] tracking-[-0.24px] text-black-700 dark:text-grey-dark-500">
          No active plan
        </p>
      )}
    </div>
  );
};

export default PlanChip;
