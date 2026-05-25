"use client";

import React from "react";

import CustomTooltip2 from "@/components/ui/CustomTooltip2";
import { cn } from "@/lib/utils";

type ProgressTone = "progress" | "success" | "error";
type ProgressSize = "sm" | "xs";

interface SyncQueueOverallProgressProps {
  percentage: number | null;
  tone?: ProgressTone;
  tooltipContent?: React.ReactNode;
  className?: string;
  label?: string;
  indeterminate?: boolean;
  showLabel?: boolean;
  size?: ProgressSize;
  detailsStart?: React.ReactNode;
  detailsEnd?: React.ReactNode;
  detailsSize?: ProgressSize;
}

const TONE_STYLES: Record<
  ProgressTone,
  {
    textClassName: string;
    fillColor: string;
    baseColor: string;
  }
> = {
  progress: {
    textClassName: "text-[#3167dd] dark:text-[#618ce8]",
    fillColor: "#3167DD",
    baseColor: "#D3DFF8",
  },
  success: {
    textClassName: "text-success-50 dark:text-[#67e89c]",
    fillColor: "#17D66F",
    baseColor: "#D9F6E5",
  },
  error: {
    textClassName: "text-error-50 dark:text-[#ff857d]",
    fillColor: "#FF7B72",
    baseColor: "#FFDAD7",
  },
};

const SIZE_CONFIG: Record<
  ProgressSize,
  {
    viewBox: number;
    circleClassName: string;
    labelClassName: string;
    gapClassName: string;
    detailsClassName: string;
    detailsGapClassName: string;
    dividerClassName: string;
  }
> = {
  sm: {
    viewBox: 12,
    circleClassName: "size-3",
    labelClassName: "font-geist-mono text-[10px] tracking-[-0.2px] uppercase",
    gapClassName: "gap-1.5",
    detailsClassName: "text-[10px] tracking-[-0.2px]",
    detailsGapClassName: "gap-[6px]",
    dividerClassName: "h-[10px] w-px bg-[#606060]/40 dark:bg-white/40",
  },
  xs: {
    viewBox: 8,
    circleClassName: "size-2",
    labelClassName: "text-[6.75px] tracking-[-0.08px]",
    gapClassName: "gap-1",
    detailsClassName: "text-[8px] tracking-[-0.16px]",
    detailsGapClassName: "gap-[6px]",
    dividerClassName: "h-[10px] w-px bg-[#606060]/40 dark:bg-white/40",
  },
};

function polarToCartesian(
  center: number,
  radius: number,
  angleInDegrees: number,
): { x: number; y: number } {
  const angleInRadians = (angleInDegrees * Math.PI) / 180;
  return {
    x: center + radius * Math.cos(angleInRadians),
    y: center + radius * Math.sin(angleInRadians),
  };
}

function getCircularSectorPath(
  percentage: number,
  radius: number,
  center: number,
): string | null {
  if (percentage <= 0) return null;

  const startAngle = -90;
  const endAngle = startAngle + (360 * percentage) / 100;
  const start = polarToCartesian(center, radius, startAngle);
  const end = polarToCartesian(center, radius, endAngle);
  const largeArcFlag = percentage > 50 ? 1 : 0;

  return [
    `M ${center} ${center}`,
    `L ${start.x} ${start.y}`,
    `A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`,
    "Z",
  ].join(" ");
}

const SyncQueueOverallProgress: React.FC<SyncQueueOverallProgressProps> = ({
  percentage,
  tone = "progress",
  tooltipContent,
  className,
  label,
  indeterminate = false,
  showLabel = true,
  size = "sm",
  detailsStart,
  detailsEnd,
  detailsSize = "sm",
}) => {
  const config = SIZE_CONFIG[size];
  const detailsConfig = SIZE_CONFIG[detailsSize];
  const toneStyle = TONE_STYLES[tone];
  const circleRadius = config.viewBox / 2;
  const circleCenter = config.viewBox / 2;
  const hasDetails = Boolean(detailsStart || detailsEnd);
  const clampedPercent =
    percentage === null ? null : Math.max(0, Math.min(100, percentage));
  const effectivePercent =
    indeterminate || clampedPercent === null ? 28 : clampedPercent;
  const isFullyFilled = effectivePercent >= 100;
  const sectorPath = getCircularSectorPath(
    effectivePercent,
    circleRadius,
    circleCenter,
  );
  const resolvedLabel =
    label ?? (clampedPercent === null ? "--" : `${clampedPercent}%`);

  const indicator = (
    <div
      className={cn(
        "inline-flex items-center font-medium leading-none",
        config.gapClassName,
        !hasDetails && className,
      )}
      data-testid={size === "sm" ? "overall-progress-trigger" : undefined}
    >
      <svg
        viewBox={`0 0 ${config.viewBox} ${config.viewBox}`}
        className={cn(
          config.circleClassName,
          "shrink-0",
          indeterminate && "animate-pulse",
        )}
        aria-hidden="true"
      >
        <circle
          cx={circleCenter}
          cy={circleCenter}
          r={circleRadius}
          fill={toneStyle.baseColor}
        />

        {isFullyFilled ? (
          <>
            <circle
              cx={circleCenter}
              cy={circleCenter}
              r={circleRadius}
              fill={toneStyle.fillColor}
            />
            {tone !== "error" && (
              <path
                d={`M ${config.viewBox * 0.3} ${config.viewBox * 0.475} L ${config.viewBox * 0.45} ${config.viewBox * 0.65} L ${config.viewBox * 0.725} ${config.viewBox * 0.325}`}
                fill="none"
                stroke="white"
                strokeWidth={config.viewBox * 0.125}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </>
        ) : sectorPath ? (
          <path d={sectorPath} fill={toneStyle.fillColor} />
        ) : null}
      </svg>

      {showLabel && (
        <span
          className={cn(config.labelClassName, toneStyle.textClassName)}
          data-testid={size === "sm" ? "overall-progress-label" : undefined}
        >
          {resolvedLabel}
        </span>
      )}
    </div>
  );

  const trigger = tooltipContent ? (
    <CustomTooltip2
      tooltipContent={tooltipContent}
      side="top"
      className="inline-flex"
    >
      {indicator}
    </CustomTooltip2>
  ) : (
    indicator
  );

  if (!hasDetails) {
    return trigger;
  }

  return (
    <div
      className={cn(
        "flex w-full items-center justify-between gap-[6px]",
        className,
      )}
    >
      {trigger}

      <div
        className={cn(
          "flex min-w-0 items-center justify-end font-medium leading-none text-grey-10/50 dark:text-white/50",
          detailsConfig.detailsClassName,
          detailsConfig.detailsGapClassName,
        )}
      >
        {detailsStart && <span className="truncate">{detailsStart}</span>}

        {detailsStart && detailsEnd && (
          <span className={detailsConfig.dividerClassName} />
        )}

        {detailsEnd && <span className="truncate">{detailsEnd}</span>}
      </div>
    </div>
  );
};

export default SyncQueueOverallProgress;
