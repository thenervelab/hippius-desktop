"use client";

import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface ChatTooltipProps {
  children: ReactNode;
  tooltipContent: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /**
   * Make the single child the trigger itself (Radix `asChild`) instead of
   * wrapping it: for real controls, so focus and `aria-describedby` land on
   * the element the user reaches. Always on here — every chat tooltip
   * wraps a button — and kept as a prop so the console markup ports as is.
   */
  asChild?: boolean;
}

/**
 * Small hover label on the chat controls (toolbar buttons, reaction chips,
 * "seen by"). Thin wrapper over the app's tooltip primitives so the chat
 * components read like the console's while using the desktop styling.
 */
export default function ChatTooltip({ children, tooltipContent, side = "top", asChild = true }: ChatTooltipProps) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild={asChild}>{children}</TooltipTrigger>
        <TooltipContent
          side={side}
          className="max-w-xs bg-grey-10 text-grey-100 dark:bg-grey-light-100 dark:text-grey-10 shadow-dialog"
        >
          {tooltipContent}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
