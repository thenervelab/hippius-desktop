"use client";

import React, { useRef } from "react";

import { Button } from "@/components/ui/button";
import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";

import { nextSkeletonState } from "@/lib/utils/skeletonGate";
import { cn } from "@/app/lib/utils";

import GripIcon from "../GripIcon";
import {
  formatPlanPrice,
  getPlanView,
} from "../storage-overview/storageOverviewState";

/**
 * The small plan card beside the storage card (mobile PlanCard's desktop
 * sibling). Renders from the SAME `get_storage_overview` fetch as the
 * storage card and the top-bar chip, so all three commit to the same
 * plan-vs-credits decision:
 *
 *   - subscription → plan name, price, allowance
 *   - credits only → credit balance (≈ $, 1 credit ≈ $1) + Top up CTA
 *   - neither      → "No active plan" + Subscribe CTA
 */
const PlanOverviewCard: React.FC<{ className?: string }> = ({ className }) => {
  const { data: overview, isLoading, isError } = useStorageOverview();

  // Same first-settle skeleton latch as the storage card: never flash
  // "No active plan" while the decision is merely still loading.
  const settledRef = useRef(false);
  const gate = nextSkeletonState(settledRef.current, isLoading);
  settledRef.current = gate.settled;

  const view = getPlanView({
    showSkeleton: gate.showSkeleton,
    isError,
    source: overview?.source,
  });

  const plan = overview?.plan ?? null;
  const creditsHip = overview?.creditsHip ?? "0";
  const dollarValue = (() => {
    const num = Number(creditsHip);
    return Number.isFinite(num) ? num.toFixed(2) : "0.00";
  })();

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
              {view === "credits" ? "Credits" : "Plan"}
            </p>
          </div>
        </div>
      </div>

      <div
        className={cn(
          "flex flex-col items-start w-full flex-1 rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
          "bg-white",
          "dark:bg-black-600 dark:border-black-300",
        )}
      >
        <div className="flex w-full flex-1 flex-col justify-center gap-1 px-4 py-4">
          {view === "skeleton" && (
            <>
              <div
                className="h-[30px] w-[160px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
                aria-label="Loading plan"
              />
              <div
                className="h-[18px] w-[120px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
                aria-hidden="true"
              />
            </>
          )}

          {view === "plan" && plan && (
            <div className="flex flex-wrap items-center justify-between gap-3 w-full">
              <div className="flex flex-col items-start gap-1 min-w-0">
                <div className="flex items-end gap-1">
                  <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white truncate">
                    {plan.name || "Active plan"}
                  </span>
                  <span className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50 pb-[3px] whitespace-nowrap">
                    {formatPlanPrice(plan.amount, plan.interval)}
                  </span>
                </div>
                <p className="text-[12px] font-medium leading-[18px] text-primary-50 dark:text-primary-brand-dark whitespace-nowrap">
                  ≈ {plan.storageDisplay} storage
                </p>
              </div>
              <Button
                asLink
                href="/billing"
                variant="defaultStable"
                size="auto"
                className="px-4 py-2 text-[14px] font-medium leading-[1.109] tracking-[-0.28px]"
              >
                Manage
              </Button>
            </div>
          )}

          {view === "credits" && (
            <div className="flex flex-wrap items-center justify-between gap-3 w-full">
              <div className="flex flex-col items-start gap-1 min-w-0">
                <div className="flex items-end gap-1">
                  <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white">
                    {creditsHip}
                  </span>
                  <span className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50 pb-[3px]">
                    credits
                  </span>
                </div>
                <p className="text-[12px] font-medium leading-[18px] text-primary-50 dark:text-primary-brand-dark whitespace-nowrap">
                  ≈ ${dollarValue}
                </p>
              </div>
              <Button
                asLink
                href="/billing"
                variant="defaultStable"
                size="auto"
                className="px-4 py-2 text-[14px] font-medium leading-[1.109] tracking-[-0.28px]"
              >
                Top up
              </Button>
            </div>
          )}

          {view === "none" && (
            <div className="flex flex-wrap items-center justify-between gap-3 w-full">
              <div className="flex flex-col items-start gap-1">
                <p className="font-mono font-medium text-[16px] leading-[24px] text-grey-10 dark:text-white">
                  No active plan
                </p>
                <p className="text-[13px] font-medium leading-[18px] text-grey-50 dark:text-grey-dark-500">
                  Subscribe or top up credits to get started.
                </p>
              </div>
              <Button
                asLink
                href="/billing"
                variant="primaryLight"
                size="auto"
                className="px-4 py-2 text-[14px] font-medium leading-[1.109] tracking-[-0.28px]"
              >
                Subscribe
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PlanOverviewCard;
