"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSpring, animated } from "@react-spring/web";
import { ChartPoint } from "@/lib/types/chartTypes";
import { nextChartAnimState } from "@/lib/utils/chartAnimation";
import { cn } from "@/app/lib/utils";

// Layout constants. The Y-axis labels and chart-area divs share the same
// vertical region (top:0 → bottom:X_AXIS_H), so simple top-percentages keep
// label "0" perfectly aligned with the bar baseline.
const Y_TICK_COUNT = 6;
const Y_AXIS_GAP = 12;
// Bottom band below the bars for the day labels. Clears both the 20px (h-5)
// label row and the centered y-axis "0" baseline label that dips ~9px below the
// baseline; 24px left them colliding in the bottom-left corner.
const X_AXIS_H = 30;

const BAR_COLOR = "#1F50BD";
const BAR_HOVER_COLOR = "#3167DD";
const BAR_WIDTH = 5;

function computeYAxisWidth(values: string[]): number {
  let maxLen = 1;
  for (const s of values) {
    if (s.length > maxLen) maxLen = s.length;
  }
  // ~6.6px per char at 12px font + 4px padding, min 28px (so "1.5 GB" fits).
  return Math.max(28, Math.ceil(maxLen * 6.6) + 4);
}

function niceYTicks(maxValue: number): { ticks: number[]; precision: number } {
  if (maxValue <= 0) return { ticks: [0, 1], precision: 0 };

  const rawStep = maxValue / (Y_TICK_COUNT - 1);
  const stepExp = Math.floor(Math.log10(rawStep));
  const stepMag = Math.pow(10, stepExp);
  const stepFrac = rawStep / stepMag;
  let nsf: number;
  if (stepFrac <= 1) nsf = 1;
  else if (stepFrac <= 2) nsf = 2;
  else if (stepFrac <= 2.5) nsf = 2.5;
  else if (stepFrac <= 5) nsf = 5;
  else nsf = 10;
  const niceStep = nsf * stepMag;
  const niceMax = Math.ceil(maxValue / niceStep) * niceStep;

  let precision = 0;
  if (niceStep > 0 && niceStep < 1) {
    precision = Math.min(Math.ceil(-Math.log10(niceStep)), 4);
  }

  const ticks: number[] = [];
  for (let v = 0; v <= niceMax + niceStep * 0.001; v += niceStep) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return { ticks, precision };
}

interface AnimatedBarProps {
  x: number;
  width: number;
  targetY: number;
  targetHeight: number;
  fill: string;
  rx: number;
  ry: number;
  delay?: number;
  baselineY: number;
}

const AnimatedBar: React.FC<AnimatedBarProps> = ({
  x,
  width,
  targetY,
  targetHeight,
  fill,
  rx,
  ry,
  delay = 0,
  baselineY,
}) => {
  const spring = useSpring({
    from: { height: 2, y: Math.max(0, baselineY - 2) },
    to: { height: targetHeight, y: targetY },
    delay,
    config: { tension: 170, friction: 26 },
  });

  return (
    <animated.rect
      x={x}
      y={spring.y}
      width={width}
      height={spring.height}
      fill={fill}
      rx={rx}
      ry={ry}
      style={{ pointerEvents: "none", transition: "fill 150ms" }}
    />
  );
};

interface StorageBarChartProps {
  data: ChartPoint[];
  isLoading?: boolean;
  className?: string;
  yTickFormat: (v: number) => string;
  formatTooltipValue?: (point: ChartPoint) => string;
  tooltipValueLabel?: string;
}

const StorageBarChart: React.FC<StorageBarChartProps> = ({
  data,
  isLoading = false,
  className = "",
  yTickFormat,
  formatTooltipValue,
  tooltipValueLabel = "Storage Used",
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Re-fire mount animations only when REAL data changes length (e.g. user
  // switches from Last 7 Days to 1 Year) — NOT on the empty-fallback round-trip
  // a background refetch causes, which would remount + re-grow every bar (the
  // periodic flash, F-8). `nextChartAnimState` owns that decision.
  const [animKey, setAnimKey] = useState(0);
  const prevAnimSigRef = useRef(String(data.length));
  useEffect(() => {
    const { signature, reanimate } = nextChartAnimState(
      prevAnimSigRef.current,
      String(data.length),
      data.length === 0,
    );
    prevAnimSigRef.current = signature;
    if (reanimate) setAnimKey((k) => k + 1);
  }, [data]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
      }
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    setSize({ w: rect.width, h: rect.height });
    return () => ro.disconnect();
  }, []);

  // Empty-data fallback: render 7 zero-valued bars for the past 7 days so the
  // chart still shows a baseline with grid + axis labels, matching the
  // Available Credits chart's empty state. Real ISO dates let the parent's
  // `formatTooltipValue` produce normal-looking "Monday, Nov 17 / 0 B"
  // tooltips on hover instead of "Invalid Date / 0 B".
  const displayData: ChartPoint[] = useMemo(() => {
    if (data.length) return data;
    const now = new Date();
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (6 - i));
      const iso = d.toISOString();
      return {
        x: iso,
        balance: 0,
        formattedBalance: "0 B",
        timestamp: iso,
        dayLabel: d
          .toLocaleDateString("en-US", { weekday: "short" })
          .toUpperCase(),
      };
    });
  }, [data]);

  const values = useMemo(
    () => displayData.map((d) => d.balance || 0),
    [displayData],
  );
  // When every bar is zero (or there's no data yet) we still want a readable
  // Y-axis. Falling back to a tiny number like 0.0001 makes every tick format
  // to "0 B"; using 1 KB instead gives a sensible empty-state scale
  // (0 B → 1 KB) without affecting cases that have real data.
  const maxValue = useMemo(() => {
    if (!values.length) return 1000;
    const m = Math.max(...values);
    return m > 0 ? m : 1000;
  }, [values]);

  const { ticks: yTicks } = useMemo(() => niceYTicks(maxValue), [maxValue]);
  const yMax = yTicks[yTicks.length - 1] || 1;
  const yLabels = useMemo(() => yTicks.map((t) => yTickFormat(t)), [yTicks, yTickFormat]);
  const yAxisW = useMemo(() => computeYAxisWidth(yLabels), [yLabels]);

  const chartLeft = yAxisW + Y_AXIS_GAP;
  const chartWidth = Math.max(0, size.w - chartLeft);
  const chartHeight = Math.max(0, size.h - X_AXIS_H);
  const baselineY = chartHeight;

  // Slot-based positioning: each bar (and its X-axis label) sits at the
  // center of an evenly-divided slot. Bars and labels share the same
  // percentage so they line up pixel-perfectly even as data length and
  // chart width change.
  const numBars = displayData.length;
  const slotW = numBars > 0 && chartWidth > 0 ? chartWidth / numBars : 0;
  const slotX = useCallback(
    (i: number) => (numBars > 0 ? ((i + 0.5) / numBars) * chartWidth : 0),
    [numBars, chartWidth],
  );
  // Y-axis labels and grid lines share the chart's vertical region exactly,
  // so we just use a straight (1 - v/yMax) percentage. tick=0 → 100% (bottom),
  // tick=yMax → 0% (top).
  const yGridLines = useMemo(
    () =>
      yTicks.map((tick, i) => ({
        pct: (1 - tick / yMax) * 100,
        label: yLabels[i],
        tick,
      })),
    [yTicks, yMax, yLabels],
  );

  const xLabels = useMemo(() => {
    const shorten = (raw: string) => {
      const trimmed = (raw ?? "").trim();
      if (/^[A-Za-z]+$/.test(trimmed) && trimmed.length > 3) {
        return trimmed.slice(0, 3).toUpperCase();
      }
      return trimmed.toUpperCase();
    };

    const longest = displayData.reduce(
      (m, d) => Math.max(m, shorten(d.dayLabel ?? "").length),
      3,
    );
    const estLabelWidth = longest * 7.2 + 14;
    const fitsAll =
      chartWidth > 0 && displayData.length * estLabelWidth <= chartWidth;
    const maxLabels = fitsAll
      ? displayData.length
      : Math.max(
          3,
          Math.min(
            7,
            chartWidth > 0 ? Math.floor(chartWidth / estLabelWidth) : 5,
          ),
        );

    const count = Math.min(displayData.length, maxLabels);
    const out: { pct: number; label: string }[] = [];
    for (let i = 0; i < count; i++) {
      const dataIdx =
        count === 1
          ? Math.floor(displayData.length / 2)
          : Math.round((i * (displayData.length - 1)) / (count - 1));
      // Slot-center percentage so the label lines up with its bar.
      const pct = ((dataIdx + 0.5) / displayData.length) * 100;
      out.push({ pct, label: shorten(displayData[dataIdx]?.dayLabel ?? "") });
    }
    return out;
  }, [displayData, chartWidth]);

  const handleBarHover = useCallback((i: number) => setHoveredIndex(i), []);
  const handleLeave = useCallback(() => setHoveredIndex(null), []);

  // Drop a hover index the data no longer covers. Nothing else clears it —
  // `onMouseLeave` doesn't fire when the data shrinks under a stationary
  // cursor (window resize past the narrow breakpoint re-samples the series;
  // a background refetch can return fewer points or the empty fallback), and
  // a stale in-range index would pin the tooltip to the wrong day.
  useEffect(() => {
    setHoveredIndex((prev) =>
      prev !== null && prev >= displayData.length ? null : prev,
    );
  }, [displayData.length]);

  const hovered = hoveredIndex !== null ? (displayData[hoveredIndex] ?? null) : null;
  const tooltipText = hovered
    ? formatTooltipValue
      ? formatTooltipValue(hovered)
      : (hovered.formattedBalance ?? String(hovered.balance))
    : null;
  const hoveredBarCenterInChart =
    hoveredIndex !== null ? slotX(hoveredIndex) : 0;
  const hoveredBarCenterInContainer = chartLeft + hoveredBarCenterInChart;
  // Derived from `hovered` (null-safe), NOT `displayData[hoveredIndex]`:
  // the reset effect above lands a render late, so the first render after a
  // shrink can still see an out-of-range index — indexing here crashed the
  // whole home subtree (review P2-1).
  const hoveredBarTopY = hovered
    ? baselineY - ((hovered.balance || 0) / yMax) * chartHeight
    : 0;

  // The outer container ALWAYS renders with `containerRef` attached so the
  // ResizeObserver fires on first paint and stays bound across loading →
  // ready transitions. If we early-returned different containers per state,
  // the observer would keep watching an unmounted node (since the
  // setup-effect has `[]` deps and never re-runs) and `size` would stay
  // frozen at {0,0} — that's what caused the 5-label / no-bars fallback.
  return (
    <div
      ref={containerRef}
      className={cn("relative w-full h-full", className)}
      onMouseLeave={handleLeave}
    >
      {isLoading ? (
        (() => {
          // 7 slot-aligned skeleton bars to match the default last7days layout —
          // when real data arrives, bars don't visually jump from edges to slots.
          const skeletonCount = 7;
          const heights = [38, 62, 28, 70, 34, 55, 42];
          return (
            <>
              {/* Y-axis label placeholders */}
              <div
                className="absolute top-0 flex flex-col items-end justify-between py-1"
                style={{ left: 0, width: yAxisW, bottom: X_AXIS_H }}
              >
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div
                    key={i}
                    className="h-3 w-7 rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
                  />
                ))}
              </div>
              {/* Dashed grid lines so the loading state matches the chart shape */}
              <div
                className="absolute pointer-events-none"
                style={{
                  left: yAxisW + Y_AXIS_GAP,
                  right: 0,
                  top: 0,
                  bottom: X_AXIS_H,
                }}
              >
                {[0, 0.2, 0.4, 0.6, 0.8, 1].map((p, i) => (
                  <div
                    key={i}
                    className="absolute left-0 right-0 border-t border-dashed border-grey-dark-100 dark:border-grey-dark-200/40"
                    style={{ top: `${p * 100}%` }}
                  />
                ))}
              </div>
              {/* Slot-aligned skeleton bars */}
              <div
                className="absolute"
                style={{
                  left: yAxisW + Y_AXIS_GAP,
                  right: 0,
                  top: 0,
                  bottom: X_AXIS_H,
                }}
              >
                {heights.map((h, i) => {
                  const pct = ((i + 0.5) / skeletonCount) * 100;
                  return (
                    <div
                      key={i}
                      className="absolute bottom-0 -translate-x-1/2 rounded-full bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
                      style={{
                        left: `${pct}%`,
                        width: BAR_WIDTH,
                        height: `${h}%`,
                      }}
                    />
                  );
                })}
              </div>
              {/* X-axis label placeholders, slot-aligned */}
              <div
                className="absolute bottom-0 h-5"
                style={{ left: yAxisW + Y_AXIS_GAP, right: 0 }}
              >
                {Array.from({ length: skeletonCount }).map((_, i) => {
                  const pct = ((i + 0.5) / skeletonCount) * 100;
                  return (
                    <div
                      key={i}
                      className="absolute -translate-x-1/2 h-3 w-7 rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
                      style={{ left: `${pct}%`, top: 2 }}
                    />
                  );
                })}
              </div>
            </>
          );
        })()
      ) : (
        <>
          {/* Y-axis labels */}
      <div
        key={`yaxis-${animKey}`}
        className="absolute top-0 pointer-events-none animate-[chartLabelSlide_0.8s_cubic-bezier(0.16,1,0.3,1)_0.2s_both]"
        style={{ left: 0, width: yAxisW, bottom: X_AXIS_H }}
      >
        {yGridLines.map((line, i) => (
          <span
            key={i}
            className="absolute right-0 -translate-y-1/2 font-medium text-[12px] leading-[18px] text-grey-10/30 dark:text-grey-dark-900 whitespace-nowrap"
            style={{ top: `${line.pct}%` }}
          >
            {line.label}
          </span>
        ))}
      </div>

      {/* Chart area: dashed grid + bars */}
      <div
        className="absolute"
        style={{ left: chartLeft, right: 0, top: 0, bottom: X_AXIS_H }}
      >
        <div className="absolute inset-0 pointer-events-none">
          {yGridLines.map((line, i) => (
            <div
              key={i}
              className="absolute left-0 right-0 border-t border-dashed border-grey-dark-100 dark:border-grey-dark-200/40"
              style={{ top: `${line.pct}%` }}
            />
          ))}
        </div>

        {chartWidth > 0 && chartHeight > 0 && (
          <svg
            width={chartWidth}
            height={chartHeight}
            className="absolute left-0 top-0 overflow-visible block"
          >
            {displayData.map((point, i) => {
              const cx = slotX(i);
              const barX = cx - BAR_WIDTH / 2;
              const fullBarHeight = ((point.balance || 0) / yMax) * chartHeight;
              const visibleHeight = Math.max(2, fullBarHeight);
              const barY = baselineY - visibleHeight;
              const isHovered = hoveredIndex === i;

              return (
                <React.Fragment key={`bar-${animKey}-${i}`}>
                  {/* Hit-area is the full slot so hovers land naturally on
                      the column the user is pointing at, not just on the
                      thin pill itself. */}
                  <rect
                    x={cx - slotW / 2}
                    y={0}
                    width={slotW}
                    height={chartHeight}
                    fill="transparent"
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => handleBarHover(i)}
                    onMouseMove={() => handleBarHover(i)}
                  />
                  {isHovered && (
                    <rect
                      x={barX - 2.25}
                      y={barY - 2.25}
                      width={BAR_WIDTH + 4.5}
                      height={visibleHeight + 4.5}
                      rx={(BAR_WIDTH + 4.5) / 2}
                      ry={(BAR_WIDTH + 4.5) / 2}
                      fill="none"
                      stroke={BAR_COLOR}
                      strokeWidth={1.5}
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                  <AnimatedBar
                    x={barX}
                    width={BAR_WIDTH}
                    targetY={barY}
                    targetHeight={visibleHeight}
                    fill={isHovered ? BAR_HOVER_COLOR : BAR_COLOR}
                    rx={BAR_WIDTH / 2}
                    ry={BAR_WIDTH / 2}
                    delay={i * 30}
                    baselineY={baselineY}
                  />
                </React.Fragment>
              );
            })}
          </svg>
        )}
      </div>

      {/* X-axis labels */}
      <div
        key={`xaxis-${animKey}`}
        className="absolute bottom-0 h-5 flex items-start pointer-events-none animate-[chartFadeIn_0.8s_cubic-bezier(0.16,1,0.3,1)_0.4s_both]"
        style={{ left: chartLeft, right: 0 }}
      >
        {xLabels.map((label, i) => (
          <span
            key={i}
            className="absolute whitespace-nowrap font-medium text-[12px] leading-[18px] text-grey-10/30 dark:text-grey-dark-900 -translate-x-1/2"
            style={{ left: `${label.pct}%` }}
          >
            {label.label}
          </span>
        ))}
      </div>

          {/* Tooltip */}
          {hoveredIndex !== null &&
            tooltipText &&
            (() => {
              const tooltipW = 200;
              const halfW = tooltipW / 2;
              const clampedX = Math.max(
                halfW + 4,
                Math.min(hoveredBarCenterInContainer, size.w - halfW - 4),
              );
              const arrowOffsetPx = hoveredBarCenterInContainer - clampedX;
              const arrowLeftPx = halfW + arrowOffsetPx;
              const arrowSafeInset = 16;
              const showArrow =
                arrowLeftPx >= arrowSafeInset &&
                arrowLeftPx <= tooltipW - arrowSafeInset;
              return (
                <div
                  className="pointer-events-none absolute z-50 -translate-x-1/2 -translate-y-full rounded-lg bg-white dark:bg-black-300 px-3 py-2 text-xs font-medium text-grey-10 dark:text-grey-light-100 shadow-[0px_4px_16px_rgba(0,0,0,0.12)] border border-grey-dark-100 dark:border-grey-dark-200/40 whitespace-nowrap"
                  style={{ left: clampedX, top: hoveredBarTopY - 12 }}
                >
                  {tooltipText.split("\n").map((line, i) => (
                    <div
                      key={i}
                      className={
                        i === 0
                          ? "text-[12px] font-normal text-grey-50 dark:text-grey-dark-500 mb-0.5"
                          : "text-[12px] font-medium text-grey-10 dark:text-white"
                      }
                    >
                      {i === 1 ? (
                        <>
                          <span className="text-grey-50 dark:text-grey-dark-500 font-normal">
                            {tooltipValueLabel}:{"  "}
                          </span>
                          <span className="font-semibold">{line}</span>
                        </>
                      ) : (
                        line
                      )}
                    </div>
                  ))}
                  {showArrow && (
                    <div
                      className="absolute -translate-x-1/2 top-full w-0 h-0 border-l-[5px] border-r-[5px] border-t-[5px] border-l-transparent border-r-transparent border-t-white dark:border-t-black-300"
                      style={{ left: `calc(50% + ${arrowOffsetPx}px)` }}
                    />
                  )}
                </div>
              );
            })()}
        </>
      )}
    </div>
  );
};

export default StorageBarChart;
