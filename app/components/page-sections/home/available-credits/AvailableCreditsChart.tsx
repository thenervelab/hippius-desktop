"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChartPoint } from "@/lib/types/chartTypes";
import { cn } from "@/app/lib/utils";

const Y_TICK_COUNT = 6;
const VB_W = 1000;
const VB_H = 300;
const CHART_PAD_TOP = 4;
const CHART_PAD_BOTTOM = 0;
const CHART_H = VB_H - CHART_PAD_TOP - CHART_PAD_BOTTOM;
export const Y_AXIS_GAP = 12;

export function computeYAxisWidth(values: number[]): number {
  if (!values.length) return 36;
  const maxVal = Math.max(...values, 0.01);
  if (maxVal <= 0) return 36;

  const rawStep = maxVal / (Y_TICK_COUNT - 1);
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
  const niceMax = Math.ceil(maxVal / niceStep) * niceStep;

  let prec = 0;
  if (niceStep > 0 && niceStep < 1) {
    prec = Math.min(Math.ceil(-Math.log10(niceStep)), 4);
  }

  let maxLen = 1;
  for (let v = 0; v <= niceMax + niceStep * 0.001; v += niceStep) {
    const t = Math.round(v * 1e6) / 1e6;
    let s: string;
    if (t === 0) s = "0";
    else if (Number.isInteger(t) && prec === 0) s = t.toLocaleString();
    else s = t.toFixed(prec);
    if (s.length > maxLen) maxLen = s.length;
  }

  return Math.max(20, Math.ceil(maxLen * 7) + 4);
}

function formatYTickValue(value: number, precision: number): string {
  if (value === 0) return "0";
  if (Number.isInteger(value) && precision === 0) {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return value.toLocaleString();
  }
  return value.toFixed(precision);
}

interface AvailableCreditsChartProps {
  data: ChartPoint[];
  color?: string;
  height?: number | string;
  isLoading?: boolean;
  className?: string;
  formatTooltipValue?: (point: ChartPoint) => string;
  tooltipValueLabel?: string;
}

const AvailableCreditsChart: React.FC<AvailableCreditsChartProps> = ({
  data,
  color = "#3167DD",
  height = "100%",
  isLoading = false,
  className = "",
  formatTooltipValue,
  tooltipValueLabel = "Credits",
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [containerWidth, setContainerWidth] = useState(0);

  const [animKey, setAnimKey] = useState(0);
  // Use a content signature so switching between same-length ranges still animates.
  const dataSignature = useMemo(
    () =>
      `${data.length}-${data[0]?.balance ?? ""}-${data[data.length - 1]?.balance ?? ""}`,
    [data],
  );
  const prevSigRef = useRef(dataSignature);
  useEffect(() => {
    if (dataSignature !== prevSigRef.current) {
      prevSigRef.current = dataSignature;
      setAnimKey((k) => k + 1);
    }
  }, [dataSignature]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    setContainerWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // Empty-data fallback: substitute 7 zero-valued points for the past 7 days
  // so a flat line + area still render at the baseline instead of a blank
  // chart. Real ISO dates let the parent's `formatTooltipValue` produce
  // normal-looking "Monday, Nov 17 / 0" tooltips on hover.
  const isEmpty = !data.length;
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
        formattedBalance: "0",
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
  const maxValue = useMemo(
    () => (values.length ? Math.max(...values, 0.01) : 1),
    [values],
  );

  const yTicks = useMemo(() => {
    // Treat "no real data" or "all zero" the same: show a sensible 0–100 axis
    // instead of niceYTicks(0.01) producing tiny fractional ticks.
    if (isEmpty || values.every((v) => v === 0))
      return [0, 25, 50, 75, 100];
    if (maxValue <= 0) return [0, 25, 50, 75, 100];

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

    const ticks: number[] = [];
    for (let v = 0; v <= niceMax + niceStep * 0.001; v += niceStep) {
      ticks.push(Math.round(v * 1e6) / 1e6);
    }
    return ticks;
  }, [isEmpty, maxValue, values]);

  const yMax = yTicks[yTicks.length - 1] || 1;
  const yLabelPrecision = useMemo(() => {
    const step = yTicks.length > 1 ? yTicks[1] : yMax;
    if (step === 0 || step >= 1) return 0;
    return Math.min(Math.ceil(-Math.log10(step)), 4);
  }, [yTicks, yMax]);

  const points = useMemo(() => {
    if (!displayData.length) return [];
    const len = displayData.length;
    return displayData.map((_, i) => {
      const x = len === 1 ? VB_W / 2 : (i / (len - 1)) * VB_W;
      const y = CHART_PAD_TOP + CHART_H - ((values[i] || 0) / yMax) * CHART_H;
      return { x, y };
    });
  }, [displayData, values, yMax]);

  const linePath = useMemo(
    () =>
      points.reduce(
        (d, p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `${d} L ${p.x} ${p.y}`),
        "",
      ),
    [points],
  );

  const areaPath = useMemo(() => {
    if (!points.length) return "";
    return `${linePath} L ${points[points.length - 1].x} ${VB_H} L ${
      points[0].x
    } ${VB_H} Z`;
  }, [linePath, points]);

  const gradientId = "available-credits-grad";

  const xLabels = useMemo(() => {
    const len = displayData.length;

    // Truncate single-word day names ("WEDNESDAY") to 3 chars ("WED") so they
    // fit without overlap. Multi-token labels ("MAR 5") are left untouched.
    const shortenLabel = (raw: string) => {
      const trimmed = raw.trim();
      if (/^[A-Za-z]+$/.test(trimmed) && trimmed.length > 3) {
        return trimmed.slice(0, 3).toUpperCase();
      }
      return trimmed.toUpperCase();
    };

    const isSmallScreen = containerWidth > 0 && containerWidth < 480;
    const longestLabel = displayData.reduce((max, d) => {
      const l = shortenLabel(d.dayLabel ?? "").length;
      return l > max ? l : max;
    }, 3);
    // ~7.2px per monospace char at 12px + 16px padding between labels
    const estLabelWidth = longestLabel * 7.2 + 16;
    const availableWidth = Math.max(0, containerWidth - 80);
    const fitsAll = availableWidth > 0 && len * estLabelWidth <= availableWidth;
    const fallbackMax = isSmallScreen ? 4 : 7;
    const maxLabels = fitsAll
      ? len
      : Math.max(
          3,
          Math.min(
            fallbackMax,
            availableWidth > 0
              ? Math.floor(availableWidth / estLabelWidth)
              : fallbackMax,
          ),
        );
    const count = Math.min(len, maxLabels);
    const labels: { pct: number; label: string }[] = [];
    for (let i = 0; i < count; i++) {
      const dataIdx =
        count === 1 ? 0 : Math.round((i * (len - 1)) / (count - 1));
      const pct = len === 1 ? 50 : (dataIdx / (len - 1)) * 100;
      const raw = displayData[dataIdx]?.dayLabel ?? "";
      labels.push({ pct, label: shortenLabel(raw) });
    }
    return labels;
  }, [displayData, containerWidth]);

  const yGridLines = useMemo(() => {
    return yTicks.map((tick) => {
      const pct =
        ((CHART_PAD_TOP + CHART_H - (tick / yMax) * CHART_H) / VB_H) * 100;
      return { pct, label: tick };
    });
  }, [yTicks, yMax]);

  const X_AXIS_H = 24;
  const Y_AXIS_W = useMemo(() => computeYAxisWidth(values), [values]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current || !points.length) return;
      const rect = containerRef.current.getBoundingClientRect();
      const chartLeft = Y_AXIS_W + Y_AXIS_GAP;
      const chartWidth = rect.width - chartLeft;
      const chartHeight = rect.height - X_AXIS_H;
      const mouseX = e.clientX - rect.left - chartLeft;
      if (mouseX < 0 || mouseX > chartWidth) return;
      const frac = mouseX / chartWidth;

      let closest = 0;
      let minDist = Infinity;
      const len = displayData.length;
      for (let i = 0; i < len; i++) {
        const ptFrac = len === 1 ? 0.5 : i / (len - 1);
        const d = Math.abs(frac - ptFrac);
        if (d < minDist) {
          minDist = d;
          closest = i;
        }
      }
      setHoverIndex(closest);

      const ptFrac = len === 1 ? 0.5 : closest / (len - 1);
      setTooltipPos({
        x: chartLeft + ptFrac * chartWidth,
        y: (points[closest].y / VB_H) * chartHeight,
      });
    },
    [points, displayData.length, Y_AXIS_W],
  );

  const handleMouseLeave = useCallback(() => setHoverIndex(null), []);

  const tooltipContent = useMemo(() => {
    if (hoverIndex === null || !displayData[hoverIndex]) return null;
    const point = displayData[hoverIndex];
    if (formatTooltipValue) return formatTooltipValue(point);
    return `${point.formattedBalance ?? point.balance}`;
  }, [hoverIndex, displayData, formatTooltipValue]);

  const hoverPct = useMemo(() => {
    if (hoverIndex === null || !displayData.length) return null;
    const len = displayData.length;
    return len === 1 ? 50 : (hoverIndex / (len - 1)) * 100;
  }, [hoverIndex, displayData.length]);

  // The outer wrapper always renders with `containerRef` attached so the
  // ResizeObserver fires on first paint and stays bound across loading →
  // ready transitions. Conditional content lives INSIDE so the ref node
  // never gets swapped out.
  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", className)}
      style={{ height }}
      onMouseMove={isLoading ? undefined : handleMouseMove}
      onMouseLeave={isLoading ? undefined : handleMouseLeave}
    >
      {isLoading ? (
        <>
          {/* Y-axis label placeholders */}
          <div
            className="absolute top-0 flex flex-col items-end justify-between py-1"
            style={{
              left: 0,
              width: `${Y_AXIS_W}px`,
              bottom: `${X_AXIS_H}px`,
            }}
          >
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-3 w-7 rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
              />
            ))}
          </div>
          {/* Dashed grid lines */}
          <div
            className="absolute pointer-events-none"
            style={{
              left: `${Y_AXIS_W + Y_AXIS_GAP}px`,
              right: 0,
              top: 0,
              bottom: `${X_AXIS_H}px`,
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
          {/* Pulsing line + area placeholder so the chart silhouette is visible
              while loading instead of an empty grid. */}
          <div
            className="absolute"
            style={{
              left: `${Y_AXIS_W + Y_AXIS_GAP}px`,
              right: 0,
              top: 0,
              bottom: `${X_AXIS_H}px`,
            }}
          >
            <div className="absolute inset-x-0 bottom-0 h-[55%] bg-grey-light-700/40 dark:bg-grey-dark-200/30 animate-pulse rounded-t-md" />
          </div>
          {/* X-axis label placeholders, slot-aligned across 7 days */}
          <div
            className="absolute bottom-0 h-5"
            style={{ left: `${Y_AXIS_W + Y_AXIS_GAP}px`, right: 0 }}
          >
            {Array.from({ length: 7 }).map((_, i) => {
              const pct = ((i + 0.5) / 7) * 100;
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
      ) : (
        <>
          <div
            key={`yaxis-${animKey}`}
            className="absolute top-0 pointer-events-none animate-[chartLabelSlide_0.8s_cubic-bezier(0.16,1,0.3,1)_0.2s_both]"
            style={{
              left: 0,
              width: `${Y_AXIS_W}px`,
              bottom: `${X_AXIS_H}px`,
            }}
          >
            {yGridLines.map((line, i) => (
              <span
                key={i}
                className="absolute right-0 -translate-y-1/2 font-medium text-[12px] leading-[18px] text-grey-10/30 dark:text-grey-dark-900 whitespace-nowrap"
                style={{ top: `${line.pct}%` }}
              >
                {formatYTickValue(line.label, yLabelPrecision)}
              </span>
            ))}
          </div>

          <div
            className="absolute inset-0"
            style={{
              left: `${Y_AXIS_W + Y_AXIS_GAP}px`,
              bottom: `${X_AXIS_H}px`,
            }}
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

            <svg
              viewBox={`0 0 ${VB_W} ${VB_H}`}
              className="absolute inset-0 w-full h-full"
              preserveAspectRatio="none"
              overflow="visible"
            >
              <defs>
                <linearGradient
                  id={gradientId}
                  x1="0%"
                  y1="0%"
                  x2="0%"
                  y2="100%"
                >
                  <stop offset="0%" stopColor={color} stopOpacity={0.2} />
                  <stop offset="60%" stopColor={color} stopOpacity={0.06} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.01} />
                </linearGradient>
              </defs>

              {areaPath && (
                <path
                  key={`area-${animKey}`}
                  d={areaPath}
                  fill={`url(#${gradientId})`}
                  className="animate-[chartAreaReveal_1.2s_cubic-bezier(0.16,1,0.3,1)_0.3s_both]"
                />
              )}
              {linePath && (
                <path
                  key={`line-${animKey}`}
                  d={linePath}
                  fill="none"
                  stroke={color}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  className="animate-[chartDraw_1.4s_cubic-bezier(0.33,1,0.68,1)_both]"
                  style={{ strokeDasharray: 2000, strokeDashoffset: 0 }}
                />
              )}
            </svg>

            {hoverPct !== null && points[hoverIndex!] && (
              <>
                <div
                  className="absolute top-0 bottom-0 w-px border-l border-dashed pointer-events-none"
                  style={{
                    left: `${hoverPct}%`,
                    borderColor: color,
                    opacity: 0.4,
                  }}
                />
                <div
                  className="absolute w-[10px] h-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-white dark:bg-black-300 pointer-events-none"
                  style={{
                    left: `${hoverPct}%`,
                    top: `${(points[hoverIndex!].y / VB_H) * 100}%`,
                    borderColor: color,
                  }}
                />
              </>
            )}
          </div>

          <div
            key={`xaxis-${animKey}`}
            className="absolute bottom-0 h-5 flex items-start pointer-events-none animate-[chartFadeIn_0.8s_cubic-bezier(0.16,1,0.3,1)_0.4s_both]"
            style={{ left: `${Y_AXIS_W + Y_AXIS_GAP}px`, right: 0 }}
          >
            {xLabels.map((label, i) => {
              const isFirst = i === 0;
              const isLast = i === xLabels.length - 1;
              return (
                <span
                  key={i}
                  className={cn(
                    "absolute whitespace-nowrap font-medium text-[12px] leading-[18px] text-grey-10/30 dark:text-grey-dark-900",
                    !isFirst &&
                      (isLast ? "-translate-x-full" : "-translate-x-1/2"),
                  )}
                  style={{ left: `${label.pct}%` }}
                >
                  {label.label}
                </span>
              );
            })}
          </div>

          {hoverIndex !== null &&
            tooltipContent &&
            (() => {
              const containerW = containerRef.current
                ? containerRef.current.getBoundingClientRect().width
                : 0;
              const tooltipW = 180;
              const halfW = tooltipW / 2;
              const clampedX = Math.max(
                halfW + 4,
                Math.min(tooltipPos.x, containerW - halfW - 4),
              );
              const arrowOffsetPx = tooltipPos.x - clampedX;
              const arrowLeftPx = halfW + arrowOffsetPx;
              const arrowSafeInset = 16;
              const showArrow =
                arrowLeftPx >= arrowSafeInset &&
                arrowLeftPx <= tooltipW - arrowSafeInset;
              return (
                <div
                  className="pointer-events-none absolute z-50 -translate-x-1/2 -translate-y-full rounded-lg bg-white dark:bg-black-300 px-3 py-2 text-xs font-medium text-grey-10 dark:text-grey-light-100 shadow-[0px_4px_16px_rgba(0,0,0,0.12)] border border-grey-dark-100 dark:border-grey-dark-200/40 whitespace-nowrap"
                  style={{ left: clampedX, top: tooltipPos.y - 12 }}
                >
                  {tooltipContent.split("\n").map((line, i) => (
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

export default AvailableCreditsChart;
