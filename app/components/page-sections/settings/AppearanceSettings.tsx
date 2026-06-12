"use client";

import React from "react";
import { SunMoon } from "lucide-react";
import { InView } from "react-intersection-observer";

import { cn } from "@/lib/utils";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { THEME_OPTIONS, ThemePreference } from "@/lib/theme";
import { useAppTheme } from "@/lib/theme-context";

/**
 * Theme picker for the Appearance settings section. Desktop port of the
 * console's ThemeSelectionSection: the same Light / Dark / System options
 * (app/lib/theme.ts) driving the shared Jotai theme preference. Styled
 * like the Security section's flat row (icon + title/description left,
 * action right), with the shared SegmentedControl in the action slot.
 * The change applies instantly via AppThemeProvider.
 */
export default function AppearanceSettings() {
  const { isLoaded, themePreference, setThemePreference } = useAppTheme();

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className={cn(
            "transition-all duration-500 ease-out",
            inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 rounded-[8px] border border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300">
            <div className="flex items-start gap-3 min-w-0">
              <SunMoon
                className="size-[18px] text-primary-50 dark:text-primary-brand-dark flex-shrink-0 mt-0.5"
                strokeWidth={2}
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-grey-10 dark:text-white">
                  Theme
                </p>
                <p className="text-sm text-[#7D7D7D] dark:text-grey-dark-600 mt-1">
                  Switch between light and dark, or pick System to follow your
                  operating system.
                </p>
              </div>
            </div>
            <SegmentedControl<ThemePreference>
              ariaLabel="Theme preference"
              disabled={!isLoaded}
              onChange={setThemePreference}
              options={THEME_OPTIONS}
              value={isLoaded ? themePreference : null}
            />
          </div>
        </div>
      )}
    </InView>
  );
}
