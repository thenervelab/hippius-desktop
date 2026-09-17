"use client";

import React from "react";
import { createPortal } from "react-dom";

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

/** Share of the whole, as a percentage string, or null when nothing is known. */
export function sharePercent(count: number, total: number): string | null {
  if (total <= 0 || count <= 0) return null;
  const pct = (count / total) * 100;
  // Never round a non-empty slice to "0%": it exists, and saying otherwise
  // contradicts the bar the reader is pointing at.
  return pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

/**
 * Where each slice's bars begin, as an index into the rendered row.
 *
 * The tooltip anchors over the segment the pointer is on rather than the
 * middle of the card, so with four slices across 35 bars it still reads as
 * belonging to the bars under it.
 */
export function barOffsets(counts: readonly number[]): number[] {
  const offsets: number[] = [];
  let run = 0;
  for (const n of counts) {
    offsets.push(run);
    run += n;
  }
  return offsets;
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

  // One tooltip driven by which slice the pointer is on, not one tooltip per
  // bar: there are 35 bars per card and two cards, and mounting a positioned
  // popover for each would cost far more than the hint is worth.
  const [hovered, setHovered] = React.useState<string | null>(null);
  const offsets = React.useMemo(() => barOffsets(bars), [bars]);
  const hoveredIndex = slices.findIndex((s) => s.key === hovered);
  const hoveredSlice = hoveredIndex >= 0 ? slices[hoveredIndex] : null;

  // The card is `overflow-hidden` for its rounded corners, so a bubble
  // positioned inside it is clipped the moment it reaches an edge — which for
  // the first slice is immediately. The tooltip is therefore portalled to the
  // body and positioned in viewport coordinates, the same escape
  // `LivePhotoToggle` makes for the same class of problem.
  const rowRef = React.useRef<HTMLDivElement>(null);
  const tipRef = React.useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = React.useState<{ x: number; y: number } | null>(
    null,
  );
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  // Anchor over the centre of the hovered slice's own run, not the bar under
  // the pointer: a run of twenty bars would otherwise drag the bubble along
  // with the cursor for no reason.
  React.useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || hoveredIndex < 0 || bars[hoveredIndex] <= 0) {
      setAnchor(null);
      return;
    }
    const rect = row.getBoundingClientRect();
    const centre =
      (offsets[hoveredIndex] + bars[hoveredIndex] / 2) / TOTAL_BARS;
    const width = tipRef.current?.getBoundingClientRect().width ?? 0;
    const margin = 8;
    // Keep the whole bubble on screen: at the extremes the anchor stops
    // tracking the bars rather than letting half the text run off the edge.
    const half = width / 2;
    const wanted = rect.left + centre * rect.width;
    const x = Math.min(
      Math.max(wanted, margin + half),
      window.innerWidth - margin - half,
    );
    setAnchor({ x, y: rect.top });
  }, [hoveredIndex, bars, offsets, slices]);

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
            <div data-breakdown-chart onMouseLeave={() => setHovered(null)}>
              {mounted && hoveredSlice
                ? createPortal(
                <div
                  ref={tipRef}
                  // `pointer-events-none`: the bubble sits over the bars, and
                  // a pointer landing on it would read as leaving them, so the
                  // tooltip would flicker itself out from under the cursor.
                  className={cn(
                    "pointer-events-none fixed z-[9999] -translate-x-1/2 -translate-y-full whitespace-nowrap",
                    "rounded-[6px] border px-2 py-1",
                    "border-grey-dark-100 bg-white text-grey-10",
                    "dark:border-black-300 dark:bg-black-600 dark:text-white",
                    "shadow-[0px_4px_12px_0px_rgba(0,0,0,0.12)]",
                    // Hidden until measured, or the first frame paints it at
                    // the top-left corner before the anchor is known.
                    anchor ? "opacity-100" : "opacity-0",
                  )}
                  style={{
                    left: anchor?.x ?? 0,
                    // 8px clear of the bars.
                    top: (anchor?.y ?? 0) - 8,
                  }}
                  role="status"
                >
                  <span className="font-mono text-[11px] font-medium uppercase leading-4 tracking-[-0.22px]">
                    {hoveredSlice.label}
                  </span>
                  <span className="ml-1.5 font-mono text-[11px] leading-4 tracking-[-0.22px] text-grey-50 dark:text-grey-dark-500">
                    {hoveredSlice.count.toLocaleString()}
                    {sharePercent(hoveredSlice.count, total)
                      ? ` · ${sharePercent(hoveredSlice.count, total)}`
                      : ""}
                  </span>
                  {hoveredSlice.note ? (
                    <span className="ml-1.5 font-mono text-[10px] leading-4 text-grey-50 dark:text-grey-dark-500">
                      {hoveredSlice.note}
                    </span>
                  ) : null}
                </div>,
                document.body,
                  )
                : null}

              <div
                ref={rowRef}
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
                      data-slice={slice.key}
                      onMouseEnter={() => setHovered(slice.key)}
                      className={cn(
                        "min-w-0 flex-1 rounded-[2px] transition-opacity",
                        // Dim the rest so the hovered run reads as one
                        // segment; four slices share 35 bars, so without this
                        // a hover over the middle says nothing about extent.
                        hovered && hovered !== slice.key && "opacity-40",
                      )}
                      style={{ backgroundColor: slice.color }}
                    />
                  )),
                )}
              </div>
            </div>

            <dl className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {slices.map((slice) => (
                <div
                  key={slice.key}
                  className="flex items-center gap-1.5"
                  tabIndex={0}
                  onMouseEnter={() => setHovered(slice.key)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(slice.key)}
                  onBlur={() => setHovered(null)}
                >
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
