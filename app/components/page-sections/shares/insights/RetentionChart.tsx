"use client";

import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "@/lib/utils";
import type { ShareComment } from "@/app/lib/tauri/shareInsights";
import { InsightsAvatar } from "./InsightsAvatar";
import { biggestDrop, formatMomentAt, formatWatched, retentionAt, viewerName } from "./insightsView";
import { CHART_BASELINE, CHART_FOCUS, CHART_INK, CHART_LABEL, CHART_TOPLINE, CHART_TOOLTIP } from "./panelStyles";

/** Comment avatars drawn on the curve, at most. The comment list has the rest. */
const MAX_MARKERS = 12;

/**
 * Minute ticks under the chart: a step of 1, 2, 5, 10, 15 or 30 minutes so
 * there are at most four. A recording under a minute gets its start and end.
 */
function timeTicks(durationMs: number): number[] {
  const minutes = durationMs / 60_000;
  if (minutes < 1) return [0, durationMs];
  const step = [1, 2, 5, 10, 15, 30, 60].find((s) => minutes / s <= 3) ?? 60;
  const ticks: number[] = [];
  for (let m = 0; m * 60_000 <= durationMs; m += step) ticks.push(m * 60_000);
  return ticks;
}

/**
 * "Where people stopped": the retention curve with each comment's author
 * placed on it at the moment they commented, and a playhead that reads
 * `1:42 · 84% still watching` under the pointer or the arrow keys.
 *
 * Positions are percentages over a `preserveAspectRatio="none"` SVG, so the
 * avatars and the playhead (plain HTML on top) line up at any width, and a
 * wider panel simply draws it wider.
 *
 * Calm on purpose: one baseline, a faint line at 100%, a soft flat fill, and
 * one value label, where the curve ends. The exact number at any point is
 * the playhead's.
 *
 * A document's pages use it too, one point per page, as the console does:
 * `pointLabel` gives the playhead's words at each point (it then snaps to
 * the points), `endLabels` the axis and `summary` the chart's name.
 */
export function RetentionChart({
  values,
  durationMs,
  comments = [],
  className,
  pointLabel,
  endLabels = ["Start", "End"],
  summary,
  testId,
}: {
  /** One value per point, 0 to 100, start to end. */
  values: readonly number[];
  /** The recording's length, or `null` when it cannot be worked out. */
  durationMs: number | null;
  comments?: readonly ShareComment[];
  className?: string;
  /** The playhead's words at point `i`, in place of the moment and "% still watching". */
  pointLabel?: (i: number) => { at: string; value: string };
  /** Under the axis when it has no time ticks. */
  endLabels?: readonly [string, string];
  /** The chart's accessible name, in place of the recording's. */
  summary?: string;
  testId?: string;
}) {
  const [at, setAt] = useState<number | null>(null);
  const liveId = useId();
  const n = Math.max(values.length - 1, 1);
  const y = (v: number) => 100 - Math.min(100, Math.max(0, v));
  const line = values.map((v, i) => `${((i / n) * 100).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const drop = useMemo(() => biggestDrop(values), [values]);
  const end = values.length > 0 ? Math.round(values[values.length - 1]) : 0;

  const markers = useMemo(() => {
    if (durationMs === null || durationMs <= 0) return [];
    return comments
      .filter((c): c is ShareComment & { atMs: number } => c.atMs !== null)
      .slice(0, MAX_MARKERS)
      .map((c) => {
        const f = Math.min(1, Math.max(0, c.atMs / durationMs));
        return { id: c.id, name: c.name, f, v: retentionAt(values, f), atMs: c.atMs };
      });
  }, [comments, durationMs, values]);

  const point = at === null || !pointLabel ? null : pointLabel(Math.round(at * n));
  const readout =
    at === null
      ? null
      : point
        ? `${point.at} · ${point.value}`
        : `${formatMomentAt(at, durationMs)} · ${Math.round(retentionAt(values, at))}% still watching`;
  const step = 1 / n;

  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    // Per page, the playhead sits on a page, never between two.
    setAt(pointLabel ? Math.round(f * n) / n : f);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = at ?? drop?.at ?? 0;
    const big = e.shiftKey ? 10 * step : step;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = from + big;
    else if (e.key === "ArrowLeft") next = from - big;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 1;
    else if (e.key === "Escape") {
      setAt(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setAt(Math.min(1, Math.max(0, Math.round(next / step) * step)));
  };

  const ticks = durationMs !== null && durationMs > 0 ? timeTicks(durationMs) : null;
  const atValue = at === null ? 0 : retentionAt(values, at);

  return (
    <div className={className}>
      <div
        role="group"
        tabIndex={0}
        aria-label={`${
          summary ??
          `Where people stopped. ${end}% reached the end.${drop ? ` Most left at ${formatMomentAt(drop.at, durationMs)}.` : ""}`
        } Use the arrow keys to read the chart.`}
        data-testid={testId}
        aria-describedby={liveId}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setAt(null)}
        onFocus={() => setAt(pointLabel ? 0 : (drop?.at ?? 0))}
        onBlur={() => setAt(null)}
        onKeyDown={onKey}
        className={cn(
          // Room above the top line for the end label and the avatars.
          "relative mt-4 h-[112px] touch-none select-none",
          CHART_FOCUS,
        )}
      >
        {/* A faint line at 100% and the one solid line at 0%. */}
        <div aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 border-t", CHART_TOPLINE)} />
        <div aria-hidden className={cn("pointer-events-none absolute inset-x-0 bottom-0 border-t", CHART_BASELINE)} />
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
          className={cn("absolute inset-0 size-full overflow-visible", CHART_INK)}
        >
          <polygon points={`0,100 ${line} 100,100`} fill="currentColor" fillOpacity={0.08} />
          <polyline
            points={line}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* The one value label: where the curve ends. */}
        {values.length > 0 && at === null && (
          <span
            aria-hidden
            data-testid="chart-end-value"
            className={cn("pointer-events-none absolute right-0 -translate-y-[calc(100%+3px)] font-medium", CHART_LABEL)}
            style={{ top: `${y(values[values.length - 1])}%` }}
          >
            {end}%
          </span>
        )}

        {/* Who commented, on the curve at their moment. */}
        {markers.map((m) => (
          <span
            key={m.id}
            aria-hidden
            title={`${viewerName(m.name)} at ${formatWatched(m.atMs)}`}
            className="absolute -translate-x-1/2 -translate-y-[calc(50%+10px)]"
            style={{ left: `${m.f * 100}%`, top: `${y(m.v)}%` }}
          >
            <InsightsAvatar name={m.name} size="xs" ring />
          </span>
        ))}

        {/* The playhead. */}
        {at !== null && (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 border-l border-grey-70 dark:border-white/20"
              style={{ left: `${at * 100}%` }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary-50 bg-white dark:border-primary-brand-dark dark:bg-[#1f1f1f]"
              style={{ left: `${at * 100}%`, top: `${y(atValue)}%` }}
            />
            <span
              aria-hidden
              className={cn(CHART_TOOLTIP, at > 0.55 ? "-translate-x-[calc(100%+10px)]" : "translate-x-[10px]")}
              style={{ left: `${at * 100}%`, top: `calc(${Math.min(y(atValue), 70)}% + 8px)` }}
            >
              {readout}
            </span>
          </>
        )}
      </div>
      {/* What the playhead reads, for a screen reader on the arrow keys. */}
      <p id={liveId} aria-live="polite" className="sr-only">
        {readout ?? ""}
      </p>
      <div aria-hidden className={cn("relative mt-1.5 h-4", CHART_LABEL)}>
        {ticks ? (
          ticks.map((t, i) => {
            const f = durationMs ? t / durationMs : 0;
            return (
              <span
                key={t}
                className={cn("absolute", i === 0 ? "" : f > 0.97 ? "-translate-x-full" : "-translate-x-1/2")}
                style={{ left: `${f * 100}%` }}
              >
                {formatWatched(t)}
              </span>
            );
          })
        ) : (
          <>
            <span className="absolute left-0">{endLabels[0]}</span>
            <span className="absolute right-0">{endLabels[1]}</span>
          </>
        )}
      </div>
    </div>
  );
}
