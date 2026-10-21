// The Insights button on a row of the Captures page: a small chart icon
// beside the row's link badge that opens the Insights sheet for that
// capture's newest link. Renders nothing off the Captures page, for a row
// with no link, or on a server without Insights (`useCaptureInsightsToken`).
// On the free plan the sheet itself shows the upgrade prompt.

"use client";

import { FC } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useAtomValue, useSetAtom } from "jotai";
import { BarChart3 } from "lucide-react";

import { insightsSheetAtom, shareInsightsEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { CAPTURES_ROUTE } from "@/app/lib/routes";
import { cn } from "@/lib/utils";
import { useDriveRoute } from "./driveRoute";
import { useCaptureInsightsToken } from "./useCaptureInsightsItem";

export const VIEW_INSIGHTS_LABEL = "View insights";

interface CaptureInsightsButtonProps {
  label: string | null | undefined;
  /** The row's drive-relative path: the same key its link badge looks up. */
  actualName: string | null | undefined;
  /** What the sheet's header calls the capture. */
  fileName: string;
  className?: string;
}

/**
 * Off the Captures page, or on a server without Insights, nothing is looked
 * up at all: every row of every drive renders this.
 */
const CaptureInsightsButton: FC<CaptureInsightsButtonProps> = (props) => {
  const { basePath } = useDriveRoute();
  const enabled = useAtomValue(shareInsightsEnabledAtom);
  if (basePath !== CAPTURES_ROUTE || !enabled) return null;
  return <InsightsButtonForLink {...props} />;
};

const InsightsButtonForLink: FC<CaptureInsightsButtonProps> = ({ label, actualName, fileName, className }) => {
  const tokenFor = useCaptureInsightsToken();
  const open = useSetAtom(insightsSheetAtom);
  const shareToken = tokenFor(label, actualName, false);
  if (!shareToken) return null;

  // The row's own click opens the file, so this stops it from getting there.
  // preventDefault guards against sitting inside the row's preview button.
  const activate = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    open({ shareToken, fileName });
  };

  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          {/* role=button rather than a <button>: the row's preview trigger is
              itself a button, and a nested one breaks hydration. Enter and
              Space work as on a native button. */}
          <span
            role="button"
            tabIndex={0}
            aria-label={VIEW_INSIGHTS_LABEL}
            data-testid="capture-insights-button"
            onClick={activate}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") activate(e);
            }}
            className={cn(
              "inline-flex flex-shrink-0 cursor-pointer items-center justify-center rounded-full p-1 transition-colors",
              "bg-primary-95 text-primary-50 hover:bg-primary-90 hover:text-primary-60",
              "dark:bg-primary-50/15 dark:text-primary-brand-dark dark:hover:bg-primary-50/25",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50/40",
              className,
            )}
          >
            <BarChart3 className="size-3.5" aria-hidden />
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={4}
            // The link badge's tooltip treatment, so the two read as a pair.
            className={cn(
              "z-50 rounded-[0.5rem] border border-grey-80 bg-white px-3 py-2 text-xs font-medium text-grey-40 shadow-lg",
              "dark:border-white/10 dark:bg-[#1c1c1e] dark:text-grey-dark-100",
              "dark:shadow-[0_8px_28px_-8px_rgba(0,0,0,0.55)] dark:ring-1 dark:ring-inset dark:ring-white/[0.04]",
            )}
          >
            {VIEW_INSIGHTS_LABEL}
            <Tooltip.Arrow className="fill-white dark:fill-[#1c1c1e]" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
};

export default CaptureInsightsButton;
