"use client";

import { type ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { cn } from "@/app/lib/utils";

interface InfoTooltipProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  learnMoreUrl?: string;
  ariaLabel?: string;
  align?: "start" | "center" | "end";
}

/**
 * Shared information tooltip for page and section headings.
 *
 * Documentation links open through Tauri instead of navigating the app webview,
 * keeping users on their current desktop route.
 */
const InfoTooltip = ({
  children,
  className,
  contentClassName,
  learnMoreUrl,
  ariaLabel = "More information",
  align = "center",
}: InfoTooltipProps) => (
  <Tooltip.Provider delayDuration={300}>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-full border border-grey-80 bg-white text-grey-50 transition-colors hover:bg-grey-90 hover:text-primary-50 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-dark-400 dark:hover:bg-black-300 dark:hover:text-white",
            className,
          )}
        >
          <Info className="size-3.5" />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="bottom"
          align={align}
          sideOffset={8}
          avoidCollisions
          collisionPadding={8}
          className={cn(
            "z-[9999] max-w-[260px] rounded-[8px] border border-grey-dark-100 bg-white px-3 py-[10px] text-[12px] font-medium leading-4 tracking-[-0.24px] text-[#52525c] shadow-[0px_4px_24px_0px_rgba(0,0,0,0.08)] dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-[#a3a3a3] dark:shadow-black/25",
            contentClassName,
          )}
        >
          {children}
          {learnMoreUrl && (
            <>
              {" "}
              <button
                type="button"
                onClick={() => void openUrl(learnMoreUrl)}
                className="font-semibold text-primary-50 underline hover:text-primary-40"
              >
                Learn More
              </button>
            </>
          )}
          <Tooltip.Arrow className="fill-white dark:fill-[#2c2c2c]" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>
);

export default InfoTooltip;
