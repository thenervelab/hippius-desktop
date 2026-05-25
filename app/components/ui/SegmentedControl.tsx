"use client";

import React from "react";
import { cn } from "@/lib/utils";

/* Segmented tab control matching the hippius-web wallet pattern.
 *
 * Single horizontal row of equal-width pills with a sliding active
 * indicator. The "pill" rides on its own absolutely-positioned
 * background span that transforms across columns instead of being
 * re-rendered per tab, so the transition is jitter-free.
 *
 * `showActiveIndicator` toggles the small leading dot on each tab —
 * console's wallet tabs hide it because the sliding background already
 * communicates selection, but other call sites may want both. */

export interface SegmentedControlOption<T extends string> {
  label: React.ReactNode;
  value: T;
}

interface SegmentedControlProps<T extends string> {
  ariaLabel: string;
  disabled?: boolean;
  fullWidth?: boolean;
  showActiveIndicator?: boolean;
  onChange: (value: T) => void;
  options: readonly SegmentedControlOption<T>[];
  value: T | null;
}

export function SegmentedControl<T extends string>({
  ariaLabel,
  disabled,
  fullWidth,
  showActiveIndicator = true,
  onChange,
  options,
  value,
}: SegmentedControlProps<T>) {
  const activeIndex =
    value === null
      ? 0
      : Math.max(
          options.findIndex((option) => option.value === value),
          0,
        );
  // The sliding background's width is the row width minus padding (8px
  // total inset) and minus gaps (4px between each option). This keeps
  // the indicator flush with each tab regardless of option count.
  const totalHorizontalOffset = 8 + Math.max(options.length - 1, 0) * 4;

  return (
    <div
      className={cn(
        "relative gap-1 rounded-[6.13px] border border-grey-dark-100 bg-grey-primary-bg p-1 shadow-[0px_1px_0px_0px_white] dark:border-black-300 dark:bg-black-primary-bg dark:shadow-[0px_1px_0px_0px_rgba(255,255,255,0.06)]",
        "dark:shadow-none",
        fullWidth ? "grid" : "inline-grid",
        disabled && "opacity-60",
      )}
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
      role="group"
      aria-label={ariaLabel}
    >
      <span
        className={cn(
          "pointer-events-none absolute bottom-1 left-1 top-1 z-0 rounded-[3.065px] border border-grey-dark-100 bg-grey-light-300 shadow-[0px_12.26px_3.831px_0px_rgba(0,0,0,0),0px_8.429px_3.065px_0px_rgba(0,0,0,0.01),0px_4.597px_3.065px_0px_rgba(0,0,0,0.04),0px_2.299px_2.299px_0px_rgba(0,0,0,0.08),0px_0.766px_0.766px_0px_rgba(0,0,0,0.09)] transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] dark:border-black-300 dark:bg-black-500 dark:shadow-[0px_0px_0px_1px_black]",
          value === null && "opacity-0",
        )}
        style={{
          width: `calc((100% - ${totalHorizontalOffset}px) / ${options.length})`,
          transform: `translateX(calc(${activeIndex * 100}% + ${activeIndex * 4}px))`,
        }}
      />

      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cn(
            "relative z-10 flex min-w-0 sm:min-w-[72px] items-center justify-center gap-1 sm:gap-[6px] rounded-[3.065px] px-2 sm:px-3 py-1.5 sm:py-2 text-[10px] sm:text-[13px] font-medium leading-[14px] tracking-[-0.26px] transition-colors duration-300 [&_svg]:size-2.5 sm:[&_svg]:size-3",
            option.value === value
              ? "text-black-900 dark:text-white"
              : "text-grey-dark-800 dark:text-white dark:opacity-50",
            disabled && "cursor-not-allowed",
          )}
          onClick={() => onChange(option.value)}
          disabled={disabled}
          aria-pressed={option.value === value}
        >
          {showActiveIndicator ? (
            <span
              className={cn(
                "size-1.5 sm:size-[7px] rounded-full transition-colors duration-300",
                option.value === value
                  ? "bg-primary-50"
                  : "bg-grey-dark-700 dark:bg-white dark:opacity-50",
              )}
            />
          ) : null}
          <span className="inline-flex items-center gap-1.5">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export default SegmentedControl;
