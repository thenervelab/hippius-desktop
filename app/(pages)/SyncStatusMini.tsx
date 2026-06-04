"use client";

import React from "react";

import CustomTooltip2 from "@/components/ui/CustomTooltip2";
import { cn } from "@/lib/utils";

type ProgressTone = "progress" | "success" | "error";

interface SyncStatusMiniProps {
  /** Overall percentage (0–100), or null while it is still indeterminate. */
  percentage: number | null;
  tone?: ProgressTone;
  /** Pulse a placeholder arc while the real percentage is unknown. */
  indeterminate?: boolean;
  /** Human-readable status, shown in the hover tooltip and the aria-label. */
  statusText: string;
  /** Invoked when the ring is clicked — expands back to the full widget. */
  onExpand?: () => void;
  /**
   * Corner the grow animation anchors to, matching where the widget lives:
   * `bottom-left` in the sidebar footer, `bottom-right` in the portal overlay.
   */
  expandOrigin?: "bottom-left" | "bottom-right";
  className?: string;
}

/**
 * Tone palette mirrors {@link SyncQueueOverallProgress} so the compact ring
 * reads as the same widget, just collapsed: `track` is the unfilled groove,
 * `fill` is the progress arc / solid-complete fill, `text` colors the label.
 */
const TONE: Record<
  ProgressTone,
  { track: string; fill: string; text: string }
> = {
  progress: {
    track: "#D3DFF8",
    fill: "#3167DD",
    text: "text-[#3167dd] dark:text-[#618ce8]",
  },
  success: {
    track: "#D9F6E5",
    fill: "#17D66F",
    text: "text-success-50 dark:text-[#67e89c]",
  },
  error: {
    track: "#FFDAD7",
    fill: "#FF7B72",
    text: "text-error-50 dark:text-[#ff857d]",
  },
};

// Geometry of the SVG ring. The viewBox is unitless; the rendered size comes
// from the `size-[30px]` class so the ring lines up with the 30px profile
// avatar directly below it in the collapsed sidebar.
const VIEWBOX = 36;
const CENTER = VIEWBOX / 2;
const STROKE = 4;
const RADIUS = CENTER - STROKE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// Width of the placeholder arc shown while indeterminate — matches the 28%
// pulse used by SyncQueueOverallProgress so the two never visibly disagree.
const INDETERMINATE_ARC = 28;

/**
 * Collapsed form of the sync status widget: a small circular progress ring
 * with the overall percentage in the middle. Rendered when the sidebar is
 * collapsed or the user minimized the widget (see {@link syncWidgetMinimizedAtom}).
 *
 * - In progress → a partial arc plus the `NN%` label.
 * - Complete → a solid disc; success also draws a white check (errors stay a
 *   plain red disc, matching the full widget's completed-error treatment).
 * - Indeterminate → a pulsing placeholder arc with no label.
 *
 * The whole ring is a button so a single click (or keyboard activation)
 * expands back to the full view via `onExpand`.
 */
const SyncStatusMini: React.FC<SyncStatusMiniProps> = ({
  percentage,
  tone = "progress",
  indeterminate = false,
  statusText,
  onExpand,
  expandOrigin = "bottom-right",
  className,
}) => {
  const toneStyle = TONE[tone];
  const clamped =
    percentage === null ? null : Math.max(0, Math.min(100, percentage));
  const isComplete = clamped !== null && clamped >= 100;
  const arcPercent =
    indeterminate || clamped === null ? INDETERMINATE_ARC : clamped;
  // strokeDasharray draws `arcLength` of stroke then an infinite gap; the SVG
  // is rotated -90° (via the class) so the arc grows clockwise from 12 o'clock.
  const arcLength = (arcPercent / 100) * CIRCUMFERENCE;
  const label = clamped === null ? "" : `${clamped}%`;

  const button = (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`Sync status: ${statusText}. Activate to expand.`}
      data-testid="sync-status-mini"
      className={cn(
        "relative inline-flex size-[30px] shrink-0 items-center justify-center rounded-full outline-none transition-transform",
        "hover:scale-105 focus-visible:ring-2 focus-visible:ring-primary-50",
        className,
      )}
    >
      <svg
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
        className={cn(
          "size-[30px] -rotate-90",
          indeterminate && "animate-pulse",
        )}
        aria-hidden="true"
      >
        {/* Unfilled track. */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke={toneStyle.track}
          strokeWidth={STROKE}
        />
        {/* Progress arc — a full ring when complete (arcPercent === 100). Kept
            as a thin outline (never a filled disc) so the complete state reads
            as the same widget as the percentage states, just finished. */}
        {arcPercent > 0 && (
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke={toneStyle.fill}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${arcLength} ${CIRCUMFERENCE}`}
          />
        )}
        {/* Complete → a tone-colored check inside the ring (no white-on-fill).
            Counter-rotate +90° to cancel the SVG's -90° so it sits upright.
            Errors stay a plain ring with no check, matching the full card. */}
        {isComplete && tone !== "error" && (
          <path
            d={`M ${VIEWBOX * 0.33} ${VIEWBOX * 0.5} L ${VIEWBOX * 0.44} ${VIEWBOX * 0.62} L ${VIEWBOX * 0.68} ${VIEWBOX * 0.38}`}
            fill="none"
            stroke={toneStyle.fill}
            strokeWidth={VIEWBOX * 0.07}
            strokeLinecap="round"
            strokeLinejoin="round"
            transform={`rotate(90 ${CENTER} ${CENTER})`}
          />
        )}
      </svg>

      {!isComplete && label && (
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center font-geist-mono text-[8px] font-semibold leading-none tracking-[-0.1px]",
            toneStyle.text,
          )}
          data-testid="sync-status-mini-label"
        >
          {label}
        </span>
      )}
    </button>
  );

  const content = statusText ? (
    <CustomTooltip2 tooltipContent={statusText} side="top" className="inline-flex">
      {button}
    </CustomTooltip2>
  ) : (
    button
  );

  // Entrance animation: a corner-anchored grow (origin = where the widget
  // lives) so collapsing the sidebar or clicking ✕ makes the ring appear to
  // grow out of that corner, mirroring the full card's expand. The animation
  // lives on this wrapper — not the button — because its `forwards` fill would
  // otherwise pin the button's transform and defeat the `hover:scale-105`
  // affordance. It replays on each mount (collapse / minimize) but not on
  // percentage re-renders (no remount).
  return (
    <span
      className={cn(
        "inline-flex animate-widget-grow-0.3",
        expandOrigin === "bottom-left" ? "origin-bottom-left" : "origin-bottom-right",
      )}
    >
      {content}
    </span>
  );
};

export default SyncStatusMini;
