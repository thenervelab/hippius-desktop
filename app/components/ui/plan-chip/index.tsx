"use client";

import React, { useRef } from "react";

import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";

import { nextSkeletonState } from "@/lib/utils/skeletonGate";
import { cn } from "@/app/lib/utils";
import { getPlanActionNote } from "./planActionView";
import {
  formatPercentLabel,
  getPlanHeading,
  getPlanView,
  getUsageTone,
  getUsedBytesDisplay,
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

/** Percent-label colour per tone, matching the bar it annotates. */
const PERCENT_TONE: Record<UsageTone, string> = {
  ok: "text-primary-50 dark:text-primary-brand-dark",
  warn: "text-warning-40 dark:text-warning-50",
  critical: "text-error-40 dark:text-error-50",
};

/**
 * The top-header plan/credits chip, shared by every page header that shows
 * the "Active Plan" cell (home `PageHeader`, the global `ui/page-header`
 * used by Files / VM / Notifications).
 *
 * Renders from the SAME `get_storage_overview` fetch as the home cards, so
 * the plan-vs-free-tier decision (made once, in Rust) is identical on every
 * surface. TWO lines — which plan (and anything wrong with it), then how
 * full it is:
 *
 *   ● STARTER   Low credits. Your plan renews in 6 days
 *   ▓▓▓▓▓░░░░░░░░░░░  2.82 GB of 10.00 GB   28%
 *
 * It was four: heading, bar, numbers, warning, each on its own row, which
 * made a header cell the tallest block on the page as soon as an account
 * needed credits — the state where the header matters most. The bar and
 * the numbers describe the SAME fact, so one row carries both; the
 * warning is a short clause and rides with the plan name.
 *
 * A subscribed account is headed by its plan's NAME; "Active Plan" only
 * repeated what the presence of a plan already implied. The free tier
 * keeps "Free Plan", which is the name of what it is on.
 *
 * The free tier used to state its allowance alone ("≈ 10.00 GB included"),
 * which names the size of the box without saying how much room is left —
 * the one thing the header is there to answer, and the thing that decides
 * whether the Upgrade button beside it matters.
 *
 * The heading waits for the decision: a skeleton holds BOTH lines until
 * the query settles, so the chip never flashes "No active plan" (or the
 * wrong heading) while loading. The error branch keeps its single line —
 * with no number to draw, a bar there would read as "nothing used".
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

  // "Updating…" rather than a byte count while the indexer catches up:
  // the pending flag comes from Rust and is never inferred from a zero,
  // which is also the genuinely-empty state.
  const used = overview
    ? getUsedBytesDisplay(overview.usedPending, overview.usedBytes)
    : null;
  const usedLabel = used?.kind === "pending" ? "Updating…" : (overview?.usedDisplay ?? "");
  // A plan quotes its own allowance; the free tier quotes the effective
  // total. Both come from Rust already formatted (H-109) so the chip and
  // the storage card cannot round the same number differently.
  const capacityLabel =
    planView === "plan" && plan ? plan.storageDisplay : (overview?.totalDisplay ?? "");
  // Why the Top up Credits button beside this is there. Rust decides that
  // the balance is short; this only says so.
  const actionNote = getPlanActionNote(overview?.planAction, plan?.renewsInDays);

  return (
    <div
      className={cn(
        // A floor, not a fixed width: the bar needs a length to be worth
        // reading, and the two lines around it are short enough that the
        // chip would otherwise collapse to the width of "Free Plan".
        "flex min-w-[248px] flex-col items-stretch justify-center gap-1.5",
        className,
      )}
    >
      {/* Row 1 — which plan, and anything wrong with it.
          The warning shares this line rather than taking one of its own:
          it is a short clause, and stacked under the numbers it turned a
          header chip into the tallest thing on the page. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1">
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
              {getPlanHeading(planView, plan?.name)}
            </span>
          )}
        </span>

        {actionNote && (
          /* Amber text, no chip or icon: the button beside it already
             carries the weight, and a second coloured block in a header
             cell competes with it for the same glance. */
          <span className="text-[12px] font-medium leading-[16px] tracking-[-0.24px] text-warning-40 dark:text-warning-50">
            {actionNote}
          </span>
        )}
      </div>

      {/* Row 2 — how full, as a bar and as the numbers behind it, on ONE
          line. They describe the same fact, so stacking them spent a whole
          row restating the bar in words. */}
      {planView === "skeleton" ? (
        <span
          className="h-[18px] w-[132px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
          aria-hidden="true"
        />
      ) : showUsageBar ? (
        <div className="flex items-center gap-2">
          <div
            role="progressbar"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Storage used"
            className="h-[4px] min-w-[56px] flex-1 overflow-hidden rounded-full bg-grey-light-700 dark:bg-grey-dark-200"
          >
            <div
              className={cn("h-full rounded-full transition-[width] duration-500", BAR_TONE[tone])}
              style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }}
            />
          </div>

          <p className="shrink-0 whitespace-pre text-[12px] leading-[18px] tracking-[-0.24px] text-black-700 dark:text-white">
            <span className="font-bold tracking-[-0.36px] text-primary-50 dark:text-primary-brand-dark">
              {usedLabel}
            </span>
            {" of "}
            {capacityLabel}
          </p>
          <span
            className={cn(
              "shrink-0 font-mono text-[12px] font-medium leading-[18px] tracking-[-0.24px]",
              PERCENT_TONE[tone],
            )}
          >
            {formatPercentLabel(percent)}
          </span>
        </div>
      ) : (
        <p className="text-[12px] font-medium leading-[18px] tracking-[-0.24px] text-black-700 dark:text-grey-dark-500">
          No active plan
        </p>
      )}
    </div>
  );
};

export default PlanChip;
