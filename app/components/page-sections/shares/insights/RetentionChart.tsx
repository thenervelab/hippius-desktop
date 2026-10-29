"use client";

import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "@/lib/utils";
import type { ShareComment } from "@/app/lib/tauri/shareInsights";
import { InsightsAvatar } from "./InsightsAvatar";
import { biggestDrop, formatMomentAt, formatWatched, retentionAt, viewerName } from "./insightsView";

/** Comment avatars drawn on the curve, at most. The comment list has the rest. */
const MAX_MARKERS = 12;

/**
 * Minute ticks under the chart: a step of 1, 2, 5, 10, 15 or 30 minutes so
 * there are at most six. A recording under a minute gets its start and end.
 */
function timeTicks(durationMs: number): number[] {
  const minutes = durationMs / 60_000;
  if (minutes < 1) return [0, durationMs];
  const step = [1, 2, 5, 10, 15, 30, 60].find((s) => minutes / s <= 5) ?? 60;
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
 * avatars and the playhead (plain HTML on top) line up at any width.
 */
export function RetentionChart({
  values,
  durationMs,
  comments = [],
  className,
}: {
  /** One value per point, 0 to 100, start to end. */
  values: readonly number[];
  /** The recording's length, or `null` when it cannot be worked out. */
  durationMs: number | null;
  comments?: readonly ShareComment[];
  className?: string;
}) {
  const [at, setAt] = useState<number | null>(null);
  const liveId = useId();
  // useId's colons are not safe inside url(#...), so the gradient gets its own.
  const fillId = `retention-fill-${liveId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
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

  const readout =
    at === null ? null : `${formatMomentAt(at, durationMs)} · ${Math.round(retentionAt(values, at))}% still watching`;
  const step = 1 / n;

  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    setAt(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
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
        aria-label={`Where people stopped. ${end}% reached the end.${
          drop ? ` Most left at ${formatMomentAt(drop.at, durationMs)}.` : ""
        } Use the arrow keys to read the chart.`}
        aria-describedby={liveId}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setAt(null)}
        onFocus={() => setAt(drop?.at ?? 0)}
        onBlur={() => setAt(null)}
        onKeyDown={onKey}
        className={cn(
          "relative mt-3 h-[120px] touch-none select-none rounded-sm outline-none",
          "focus-visible:ring-2 focus-visible:ring-primary-50/40 focus-visible:ring-offset-4",
          "focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#1f1f1f]",
        )}
      >
        {/* Gridlines at 100%, 50% and 0%, labelled at the right. */}
        {[100, 50, 0].map((v) => (
          <div
            key={v}
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 border-t",
              v === 0
                ? "border-grey-80 dark:border-[#494949]"
                : "border-dashed border-grey-80/80 dark:border-[#3a3a3a]",
            )}
            style={{ top: `${y(v)}%` }}
          >
            <span className="absolute -top-4 right-0 font-mono text-[10px] text-grey-50 dark:text-grey-dark-600">
              {v}%
            </span>
          </div>
        ))}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
          className="absolute inset-0 size-full overflow-visible text-primary-50 dark:text-primary-brand-dark"
        >
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity={0.22} />
              <stop offset="1" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          <polygon points={`0,100 ${line} 100,100`} fill={`url(#${fillId})`} />
          <polyline
            points={line}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

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
              className="pointer-events-none absolute inset-y-0 border-l border-dashed border-grey-50 dark:border-grey-dark-600"
              style={{ left: `${at * 100}%` }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary-50 bg-white dark:border-primary-brand-dark dark:bg-[#1f1f1f]"
              style={{ left: `${at * 100}%`, top: `${y(atValue)}%` }}
            />
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute z-10 whitespace-nowrap rounded-[7px] px-2 py-1 text-[11.5px] font-medium",
                "bg-grey-10 text-white dark:bg-white dark:text-grey-10",
                at > 0.55 ? "-translate-x-[calc(100%+10px)]" : "translate-x-[10px]",
              )}
              style={{ left: `${at * 100}%`, top: `calc(${y(atValue)}% + 12px)` }}
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
      <div aria-hidden className="relative mt-1.5 h-4 font-mono text-[10px] text-grey-50 dark:text-grey-dark-600">
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
            <span className="absolute left-0">Start</span>
            <span className="absolute right-0">End</span>
          </>
        )}
      </div>
    </div>
  );
}
