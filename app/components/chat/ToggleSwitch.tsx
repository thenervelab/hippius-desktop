"use client";

import { cn } from "@/lib/utils";

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name; the visible label lives next to the switch. */
  ariaLabel: string;
  className?: string;
}

/**
 * Small on/off switch. The console has no Radix switch primitive; this is
 * a `role="switch"` button in the house palette.
 */
export default function ToggleSwitch({ checked, onChange, disabled, ariaLabel, className }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-primary-50 focus-visible:ring-offset-1 dark:focus-visible:ring-primary-40",
        checked
          ? "border-primary-50 bg-primary-50 dark:border-primary-50 dark:bg-primary-50"
          : "border-grey-70 bg-grey-80 dark:border-black-300 dark:bg-black-500",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-4 rounded-full bg-white shadow transition-transform dark:bg-grey-light-100",
          checked ? "translate-x-[18px]" : "translate-x-[1px]",
        )}
      />
    </button>
  );
}
