"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSpring, animated } from "@react-spring/web";
import { cn } from "@/lib/utils";

/* Sparkline-style bar chart used on referral stat cards. Ported from
 * hippius-web verbatim — bars resize to fill the container, animate in,
 * and render a tooltip with the bucket label + value on hover. */

const MIN_BAR_WIDTH = 2;
const MAX_BAR_WIDTH = 6;
/** Desired gap-to-bar ratio: gap ≈ 2.5× bar width, but clamped. */
const GAP_RATIO = 2.5;
const MIN_GAP = 3;
const MAX_GAP = 8;

const BAR_COLOR = "#1F50BD";
const BAR_HOVER_COLOR = "#1639A0";

export interface ChartDataPoint {
  value: number;
  label: string;
}

interface MiniBarChartProps {
  data: ChartDataPoint[];
  height?: number;
  className?: string;
  isLoading?: boolean;
  tooltipLabel?: string;
}

function AnimatedBar({
  x,
  targetY,
  width,
  targetHeight,
  fill,
  rx,
  ry,
  delay = 0,
  chartHeight,
}: {
  x: number;
  targetY: number;
  width: number;
  targetHeight: number;
  fill: string;
  rx: number;
  ry: number;
  delay?: number;
  chartHeight: number;
}) {
  const spring = useSpring({
    from: { height: 2, y: chartHeight - 2 },
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
}

/** Compute bar width and gap to fill the available container width. */
function computeBarLayout(containerWidth: number, numBars: number) {
  if (numBars <= 0 || containerWidth <= 0)
    return { barWidth: MIN_BAR_WIDTH, gap: MIN_GAP };

  // w = containerWidth / (numBars + (numBars - 1) * GAP_RATIO)
  const idealBarWidth =
    containerWidth / (numBars + (numBars - 1) * GAP_RATIO);
  const barWidth = Math.min(
    MAX_BAR_WIDTH,
    Math.max(MIN_BAR_WIDTH, Math.round(idealBarWidth)),
  );

  const remainingSpace = containerWidth - numBars * barWidth;
  const idealGap = numBars > 1 ? remainingSpace / (numBars - 1) : 0;
  const gap =
    numBars > 1
      ? Math.min(MAX_GAP, Math.max(MIN_GAP, Math.round(idealGap)))
      : 0;

  return { barWidth, gap };
}

const MiniBarChart: React.FC<MiniBarChartProps> = ({
  data,
  height = 64,
  className = "",
  isLoading = false,
  tooltipLabel = "Value",
}) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const numBars = data?.length || 0;
  const { barWidth, gap } = useMemo(
    () => computeBarLayout(containerWidth, numBars),
    [containerWidth, numBars],
  );
  const chartWidth = numBars * barWidth + Math.max(0, numBars - 1) * gap;
  const outlinePad = 3;

  const values = useMemo(() => data?.map((d) => d.value) ?? [], [data]);

  const yScale = useMemo(() => {
    if (values.length === 0) return () => 0;
    const maxVal = Math.max(...values, 1);
    return (value: number) => height - (value / maxVal) * (height - 4);
  }, [values, height]);

  /* Clamp tooltip within container bounds so the tooltip never gets
   * clipped against the card's right edge. */
  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    const container = containerRef.current;
    if (hoveredIndex === null || !tooltip || !container) return;

    tooltip.style.transform = "translateX(-50%) translateY(-100%)";

    const tooltipRect = tooltip.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    let shiftX = 0;
    if (tooltipRect.right > containerRect.right + 40) {
      shiftX = containerRect.right + 40 - tooltipRect.right;
    } else if (tooltipRect.left < containerRect.left - 40) {
      shiftX = containerRect.left - 40 - tooltipRect.left;
    }

    if (shiftX !== 0) {
      tooltip.style.transform = `translateX(calc(-50% + ${shiftX}px)) translateY(-100%)`;
    }
  }, [hoveredIndex]);

  const handleMouseMove = useCallback(
    (_event: React.MouseEvent<SVGRectElement>, i: number) => {
      setHoveredIndex(i);
    },
    [],
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredIndex(null);
  }, []);

  if (isLoading) {
    return (
      <div
        className={cn("flex items-end gap-[5px] shrink-0", className)}
        style={{ height }}
      >
        {[45, 62, 38, 70, 28, 52, 35].map((h, i) => (
          <div
            key={i}
            className="animate-pulse rounded-full bg-[#dfe8ff]/40 dark:bg-[#2c2c2c]/70"
            style={{ width: 2, height: (h / 100) * height }}
          />
        ))}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div
        className={cn("flex items-center justify-center", className)}
        style={{ height }}
      >
        <p className="text-[12px] font-medium text-grey-50 dark:text-grey-dark-800">
          No data
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn("relative overflow-visible", className)}
      style={{ minWidth: 40, height: height + outlinePad }}
    >
      <svg
        width={chartWidth}
        height={height + outlinePad}
        className="overflow-visible block ml-auto"
      >
        {data.map((point, i) => {
          const barX = i * (barWidth + gap);
          const barBaseline = height;
          const barH = barBaseline - yScale(point.value);
          const barY = barBaseline - barH;
          const isHovered = hoveredIndex === i;

          return (
            <React.Fragment key={`bar-${i}`}>
              {/* Invisible wider hit area for easier hover */}
              <rect
                x={barX - 4}
                y={0}
                width={barWidth + 8}
                height={height + outlinePad}
                fill="transparent"
                style={{ cursor: "pointer" }}
                onMouseMove={(e) => handleMouseMove(e, i)}
                onMouseLeave={handleMouseLeave}
              />
              {/* Outer outline pill when hovered */}
              {isHovered && (
                <rect
                  x={barX - 2}
                  y={barY - 2}
                  width={barWidth + 4}
                  height={Math.max(barH, 2) + 4}
                  rx={(barWidth + 4) / 2}
                  ry={(barWidth + 4) / 2}
                  fill="none"
                  stroke="#9BB3F0"
                  strokeWidth={1}
                  style={{ pointerEvents: "none" }}
                />
              )}
              {/* Animated pill-shaped bar */}
              <AnimatedBar
                x={barX}
                targetY={barY}
                width={barWidth}
                targetHeight={Math.max(barH, 2)}
                fill={isHovered ? BAR_HOVER_COLOR : BAR_COLOR}
                rx={barWidth / 2}
                ry={barWidth / 2}
                delay={i * 40}
                chartHeight={height}
              />
            </React.Fragment>
          );
        })}
      </svg>

      {/* Tooltip */}
      {hoveredIndex !== null && data[hoveredIndex] !== undefined && (
        <div
          ref={tooltipRef}
          className="pointer-events-none absolute z-50 -translate-x-1/2 -translate-y-full rounded-lg bg-white dark:bg-[#2c2c2c] px-3 py-2 text-xs font-medium text-grey-10 dark:text-grey-light-100 shadow-[0px_4px_16px_rgba(0,0,0,0.12)] border border-grey-80 dark:border-[#494949] dark:shadow-lg whitespace-nowrap"
          style={{
            left: hoveredIndex * (barWidth + gap) + barWidth / 2,
            top: yScale(data[hoveredIndex].value) - 10,
          }}
        >
          {/* Date label */}
          <div className="text-[11px] font-normal text-grey-50 dark:text-[#a3a3a3] mb-0.5">
            {data[hoveredIndex].label}
          </div>
          {/* Value */}
          <div className="text-[13px] font-medium text-grey-10 dark:text-white">
            <span className="text-grey-50 dark:text-[#a3a3a3] font-normal">
              {tooltipLabel}:{" "}
            </span>
            <span className="font-semibold">{data[hoveredIndex].value}</span>
          </div>
          {/* Arrow */}
          <div className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-[5px] border-r-[5px] border-t-[5px] border-l-transparent border-r-transparent border-t-white dark:border-t-[#2c2c2c]" />
        </div>
      )}
    </div>
  );
};

export default MiniBarChart;
