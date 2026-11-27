"use client";

import { useId, useState, type KeyboardEvent } from "react";

import { cn } from "@/lib/utils";
import { CHART_BAR, CHART_BAR_ACTIVE, CHART_BAR_EMPTY, CHART_BASELINE, CHART_FOCUS, CHART_LABEL, CHART_TOOLTIP } from "./panelStyles";

/** The highest index with the largest value, or `null` when every value is 0. */
export function tallestIndex(values: readonly number[]): number | null {
  let best: number | null = null;
  values.forEach((v, i) => {
    if (v > 0 && (best === null || v > values[best])) best = i;
  });
  return best;
}

/**
 * One soft bar per page with a rounded top, on one baseline: the time per
 * page on a document's Pages tab and in one viewer's visits. The tallest bar
 * carries the one value label; any bar's exact value shows under the pointer
 * or the arrow keys, and each page is also a list item for a screen reader.
 * Bars share the width, so a wider panel draws them wider.
 */
export function PageBars({
  values,
  label,
  valueText,
  listLabel,
  summary,
  height = 96,
  testId,
}: {
  /** One value per page, 0 or more. */
  values: readonly number[];
  /** What page `i` is called: "Page 3". */
  label: (i: number) => string;
  /** Page `i`'s value in words: "0:17", or "not seen". */
  valueText: (i: number) => string;
  /** The list's accessible name. */
  listLabel: string;
  /** The chart's accessible name: what it shows and its main point. */
  summary: string;
  height?: number;
  testId?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const liveId = useId();
  const n = values.length;
  const max = Math.max(0, ...values);
  const tallest = tallestIndex(values);
  const readout = active === null ? null : `${label(active)} · ${valueText(active)}`;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = active ?? tallest ?? 0;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = from + 1;
    else if (e.key === "ArrowLeft") next = from - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Escape") {
      setActive(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setActive(Math.min(n - 1, Math.max(0, next)));
  };

  // The label sits over its bar, kept inside the chart at either end.
  const edge = (i: number) => (n <= 1 ? 0.5 : i / (n - 1));
  const anchor = (i: number) => (edge(i) < 0.2 ? "left-0" : edge(i) > 0.8 ? "right-0" : "left-1/2 -translate-x-1/2");

  return (
    <div>
      <div
        role="group"
        tabIndex={0}
        aria-label={`${summary} Use the arrow keys to read the chart.`}
        aria-describedby={liveId}
        data-testid={testId}
        onFocus={() => setActive(tallest ?? 0)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        onKeyDown={onKey}
        className={cn("relative mt-6 select-none", CHART_FOCUS)}
        style={{ height }}
      >
        <ol
          aria-label={listLabel}
          className={cn("flex h-full items-end border-b", CHART_BASELINE, n > 24 ? "gap-px" : "gap-[3px]")}
        >
          {values.map((v, i) => {
            const pct = max > 0 && v > 0 ? Math.max(6, (v / max) * 100) : 0;
            const on = active === i;
            return (
              <li
                key={i}
                onPointerEnter={() => setActive(i)}
                onPointerDown={() => setActive(i)}
                className="relative flex h-full min-w-0 flex-1 items-end"
              >
                <span className="sr-only">
                  {label(i)}, {valueText(i)}
                </span>
                <span
                  aria-hidden
                  data-testid="page-bar"
                  className={cn(
                    "block w-full transition-colors",
                    v > 0 ? cn("rounded-t-[3px]", on ? CHART_BAR_ACTIVE : CHART_BAR) : cn("h-[2px]", CHART_BAR_EMPTY),
                  )}
                  style={v > 0 ? { height: `${pct}%` } : undefined}
                />
                {i === tallest && active === null && (
                  <span
                    aria-hidden
                    data-testid="chart-max-value"
                    className={cn("pointer-events-none absolute font-medium whitespace-nowrap", CHART_LABEL, anchor(i))}
                    style={{ bottom: `calc(${pct}% + 3px)` }}
                  >
                    {valueText(i)}
                  </span>
                )}
                {on && (
                  <span aria-hidden className={cn(CHART_TOOLTIP, anchor(i))} style={{ bottom: `calc(${pct}% + 6px)` }}>
                    {readout}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      <p id={liveId} aria-live="polite" className="sr-only">
        {readout ?? ""}
      </p>
      {n > 1 && (
        <div aria-hidden className={cn("mt-1.5 flex justify-between", CHART_LABEL)}>
          <span>{label(0)}</span>
          <span>{label(n - 1)}</span>
        </div>
      )}
    </div>
  );
}
