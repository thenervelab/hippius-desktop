"use client";

import React from "react";

import { cn } from "@/app/lib/utils";

/** One coloured segment of the bar, and one legend entry. */
export interface BreakdownSlice {
  key: string;
  label: string;
  count: number;
  /** Explicit hex, not a token: these are chart colours, not UI surface. */
  color: string;
  /** Appended to the legend in muted text, for a bucket that needs a caveat. */
  note?: string;
}

/**
 * Total bars drawn. The console uses the same fixed count, which is what
 * makes two of these cards read as one system: the bars line up between
 * them regardless of how many files each is describing.
 */
const TOTAL_BARS = 35;

/**
 * Allocate whole bars to slices, proportionally, losing nothing.
 *
 * Largest-remainder rather than rounding each share independently: rounding
 * can spend 34 or 36 bars, and a chart that is a bar short of its neighbour
 * reads as a rendering fault.
 *
 * Every slice with at least one file keeps at least one bar, so a category
 * that exists is never invisible, EXCEPT when there are more non-empty
 * slices than bars, where the smallest shares go dark instead of the row
 * overflowing. Both breakdowns draw four slices, so that branch is a
 * guard rather than a case anyone sees.
 */
export function allocateBars(
  slices: readonly BreakdownSlice[],
  totalBars: number = TOTAL_BARS,
): number[] {
  const total = slices.reduce((sum, s) => sum + Math.max(0, s.count), 0);
  if (total <= 0) return slices.map(() => 0);

  const exact = slices.map((s) => (Math.max(0, s.count) / total) * totalBars);
  // A non-empty slice floors to at least one, so "3 files out of 400000"
  // still shows up as something rather than nothing.
  const base = exact.map((value, i) =>
    slices[i].count > 0 ? Math.max(1, Math.floor(value)) : 0,
  );

  let spent = base.reduce((sum, n) => sum + n, 0);
  // Hand out what rounding left over, biggest remainder first.
  const order = slices
    .map((_, i) => i)
    .filter((i) => slices[i].count > 0)
    .sort((a, b) => exact[b] - Math.floor(exact[b]) - (exact[a] - Math.floor(exact[a])));

  let cursor = 0;
  while (spent < totalBars && order.length > 0) {
    base[order[cursor % order.length]] += 1;
    cursor += 1;
    spent += 1;
  }
  // Over-spent, which happens when there are more non-empty slices than
  // bars: every one floored up to 1 and that already exceeds the budget.
  // The smallest shares go dark rather than the row overflowing, because a
  // bar row that wraps to a second line stops reading as one chart. Taking
  // from the largest cannot fix this: with every slice at 1 there is
  // nothing to take without erasing a slice anyway.
  if (spent > totalBars) {
    const smallestFirst = [...order].sort((a, b) => exact[a] - exact[b]);
    for (const i of smallestFirst) {
      if (spent <= totalBars) break;
      const take = Math.min(base[i], spent - totalBars);
      base[i] -= take;
      spent -= take;
    }
  }
  return base;
}

/**
 * A proportional bar chart of one breakdown, with its legend.
 *
 * One component for both Overview breakdowns (file types, upload sources),
 * because they are the same chart with different buckets. Two near-copies is
 * how one of them gains a fix the other never gets.
 */
const BreakdownCard: React.FC<{
  title: string;
  icon: React.ReactNode;
  slices: readonly BreakdownSlice[];
  isLoading?: boolean;
  isError?: boolean;
  emptyText: string;
  /** Parked at the end of the header row: the breakdown's own tab control. */
  headerRight?: React.ReactNode;
  className?: string;
}> = ({
  title,
  icon,
  slices,
  isLoading,
  isError,
  emptyText,
  headerRight,
  className,
}) => {
  const bars = React.useMemo(() => allocateBars(slices), [slices]);
  const total = slices.reduce((sum, s) => sum + Math.max(0, s.count), 0);

  return (
    <section
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-[8px] border",
        "bg-grey-light-300 border-grey-dark-100",
        "dark:bg-black-primary-bg dark:border-black-300",
        "shadow-[0px_1px_1.1px_0px_rgba(0,0,0,0.04)]",
        className,
      )}
    >
      {/* No drag grip here. That icon carries no intrinsic size, so without
          an explicit size class it expands to the SVG's own default box: it
          rendered as three oversized circles AND pushed the title to the
          right edge. The product icon already labels the card, so it is
          dropped rather than resized. */}
      {/* `min-h-[52px]` is shared with the storage card header beside it.
          This one is sized by its tab control, so that is the height the
          pair has to agree on. */}
      <div className="flex min-h-[52px] w-full flex-wrap items-center gap-x-1.5 gap-y-2 py-2 pl-[14px] pr-[10px]">
        <span className="shrink-0 text-primary-40 dark:text-primary-brand-dark">
          {icon}
        </span>
        <p className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark">
          {title}
        </p>
        {headerRight ? <div className="shrink-0">{headerRight}</div> : null}
      </div>

      {/* Inner panel: border-t + top corners only, the billing-card pattern.
          A full border on both draws a doubled line. */}
      <div className="flex w-full flex-1 flex-col gap-3 rounded-t-[8px] border-t border-grey-dark-100 bg-white px-4 py-4 dark:border-black-300 dark:bg-black-600">
        {isLoading ? (
          <>
            <div className="h-[72px] w-full animate-pulse rounded bg-grey-light-700 dark:bg-grey-dark-200" />
            <div className="h-4 w-48 animate-pulse rounded bg-grey-light-700 dark:bg-grey-dark-200" />
          </>
        ) : isError ? (
          <p className="text-[13px] font-medium leading-[18px] text-grey-50 dark:text-grey-dark-500">
            Couldn&apos;t load this breakdown.
          </p>
        ) : total === 0 ? (
          <p className="text-[13px] font-medium leading-[18px] text-grey-50 dark:text-grey-dark-500">
            {emptyText}
          </p>
        ) : (
          <>
            <div
              className="flex h-[72px] items-stretch gap-[3px]"
              role="img"
              aria-label={`${title}: ${slices
                .filter((s) => s.count > 0)
                .map((s) => `${s.label} ${s.count}`)
                .join(", ")}`}
            >
              {slices.flatMap((slice, i) =>
                Array.from({ length: bars[i] }, (_, j) => (
                  <span
                    key={`${slice.key}-${j}`}
                    className="min-w-0 flex-1 rounded-[2px]"
                    style={{ backgroundColor: slice.color }}
                  />
                )),
              )}
            </div>

            <dl className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {slices.map((slice) => (
                <div key={slice.key} className="flex items-center gap-1.5">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: slice.color }}
                  />
                  <dt className="font-mono text-[11px] font-medium uppercase leading-4 tracking-[-0.22px] text-grey-10 dark:text-white">
                    {slice.label}
                  </dt>
                  <dd className="font-mono text-[11px] font-medium leading-4 tracking-[-0.22px] text-grey-50 dark:text-grey-dark-500">
                    {slice.count.toLocaleString()}
                    {slice.note ? ` ${slice.note}` : ""}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </section>
  );
};

export default BreakdownCard;
