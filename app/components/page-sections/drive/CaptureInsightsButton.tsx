// The Insights button on a row of the Captures page: a small bordered button
// with the chart icon beside the row's link badge that opens the Insights
// sheet for that capture's newest link. Every screenshot and recording has
// one; a capture with no link yet gets a quieter one that opens the sheet's
// "Create link" step. Renders nothing off the Captures page, for a folder or
// another kind of file, or on a server without Insights
// (`useCaptureInsightsShare`). On the free plan the sheet itself shows the
// upgrade prompt.

"use client";

import { FC } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { BarChart3 } from "lucide-react";

import {
  insightsSheetAtom,
  shareInsightsEnabledAtom,
  type CaptureLinkSource,
  shareInsightsSeenEnabledAtom,
  shareListingCountsEnabledAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { CAPTURES_ROUTE } from "@/app/lib/routes";
import { getLinkSettings } from "@/app/lib/tauri/shareInsights";
import type { ShareSummary } from "@/app/lib/tauri/shares";
import { linkSettingsQueryKey } from "@/components/page-sections/shares/insights/queryKeys";
import { cn } from "@/lib/utils";
import { useDriveRoute } from "./driveRoute";
import { captureLinkSource, useCaptureInsightsShare, VIEW_INSIGHTS_LABEL } from "./useCaptureInsightsItem";

export { VIEW_INSIGHTS_LABEL };

/** The tooltip on the button of a capture that has no link yet. */
export const NO_LINK_TOOLTIP = "No link yet. Open to create one and see insights.";

/** What the button says, and whether it reads as off. */
export interface InsightsButtonView {
  label: string;
  off: boolean;
  /** Something happened since the owner last opened this link's Insights. */
  newSinceSeen: boolean;
}

/**
 * The button's words from what is known about the link. Per-link counts and
 * last-seen come from the share listing only once the server has them
 * (`share_listing_counts`, `share_insights_seen`, hcfs #805); until then it
 * says "Insights", or "Insights off" when this link is known not to count
 * views. Insights are never fetched per row to make up a count.
 */
export function insightsButtonView(
  share: Pick<ShareSummary, "views" | "insightsOn" | "newSinceSeen">,
  {
    listingCounts,
    insightsSeen,
    insightsOff,
  }: {
    listingCounts: boolean;
    insightsSeen: boolean;
    /** The link's switch as the sheet last read it, when it has. */
    insightsOff: boolean;
  },
): InsightsButtonView {
  const off = insightsOff || (listingCounts && share.insightsOn === false);
  const views = listingCounts && !off && typeof share.views === "number" ? share.views : null;
  return {
    label: off ? "Insights off" : views !== null ? `${views} ${views === 1 ? "view" : "views"}` : "Insights",
    off,
    newSinceSeen: insightsSeen && !off && share.newSinceSeen === true,
  };
}

interface CaptureInsightsButtonProps {
  label: string | null | undefined;
  /** The row's drive-relative path: the same key its link badge looks up. */
  actualName: string | null | undefined;
  /** What the sheet's header calls the capture. */
  fileName: string;
  /** The row's file, for the sheet's thumbnail. */
  file?: FormattedUserFile;
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

const InsightsButtonForLink: FC<CaptureInsightsButtonProps> = ({ label, actualName, fileName, file, className }) => {
  const shareFor = useCaptureInsightsShare();
  const { offered, share } = shareFor(label, actualName, false, file?.size);
  if (!offered) return null;
  const capture =
    label && actualName
      ? file
        ? captureLinkSource({ ...file, label }, actualName)
        : { label, relativePath: actualName }
      : undefined;
  return <InsightsButton share={share} capture={capture} fileName={fileName} file={file} className={className} />;
};

/**
 * The button for a capture's newest link, or for a capture with none yet
 * (`share` null), which opens the sheet's "Create link" step (exported for
 * its tests).
 */
export const InsightsButton: FC<{
  share: ShareSummary | null;
  capture?: CaptureLinkSource;
  fileName: string;
  file?: FormattedUserFile;
  className?: string;
}> = ({ share, capture, fileName, file, className }) => {
  const open = useSetAtom(insightsSheetAtom);
  const listingCounts = useAtomValue(shareListingCountsEnabledAtom);
  const insightsSeen = useAtomValue(shareInsightsSeenEnabledAtom);
  const shareToken = share?.shareToken ?? null;
  // The switch as the sheet (or the share dialog) last read it. Never
  // fetched from here: the listing does not carry it, and one request per
  // row is what this must not do.
  const cached = useQuery({
    queryKey: linkSettingsQueryKey(shareToken ?? ""),
    queryFn: () => getLinkSettings(shareToken ?? ""),
    enabled: false,
  });
  const insightsOff = share !== null && cached.data?.offered.insights === true && cached.data.on.insights === false;
  const view: InsightsButtonView = share
    ? insightsButtonView(share, { listingCounts, insightsSeen, insightsOff })
    : { label: "Insights", off: false, newSinceSeen: false };
  const noLink = share === null;

  // The row's own click opens the file, so this stops it from getting there.
  // preventDefault guards against sitting inside the row's preview button.
  const activate = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    open({ shareToken, fileName, file, ...(capture ? { capture } : {}) });
  };

  const tooltip = noLink ? NO_LINK_TOOLTIP : view.off ? "Insights are off for this link" : VIEW_INSIGHTS_LABEL;
  // The visible words lead the name, so a voice user can say what they see.
  const name = [
    view.off ? `${view.label}, view insights` : view.label === "Insights" ? VIEW_INSIGHTS_LABEL : `${view.label}, view insights`,
    noLink ? "no link yet" : null,
    view.newSinceSeen ? "new since you last looked" : null,
  ]
    .filter(Boolean)
    .join(", ");
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
            aria-label={name}
            data-testid="capture-insights-button"
            data-off={view.off ? "true" : undefined}
            data-no-link={noLink ? "true" : undefined}
            onClick={activate}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") activate(e);
            }}
            className={cn(
              "relative inline-flex h-6 flex-shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[7px] border pl-1.5 pr-2",
              "text-xs font-semibold tabular-nums transition-colors",
              "border-grey-80 bg-white text-grey-10 hover:bg-grey-100",
              "dark:border-[#494949] dark:bg-[#1f1f1f] dark:text-white dark:hover:bg-[#2a2a2a]",
              view.off && "border-dashed font-medium text-grey-50 dark:text-grey-dark-600",
              // No link yet: the same button, quieter, so the rows that have
              // numbers to show still stand out.
              noLink && "font-medium text-grey-50 dark:text-grey-dark-600",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50/40",
              className,
            )}
          >
            <BarChart3
              className={cn(
                "size-3.5",
                view.off || noLink ? "text-grey-50 dark:text-grey-dark-600" : "text-primary-50 dark:text-primary-brand-dark",
              )}
              aria-hidden
            />
            {view.label}
            {view.newSinceSeen && (
              <span
                aria-hidden
                data-testid="insights-new-dot"
                className="absolute -right-[3px] -top-[3px] size-[9px] rounded-full bg-primary-50 ring-2 ring-white dark:bg-primary-brand-dark dark:ring-[#1f1f1f]"
              />
            )}
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
            {tooltip}
            <Tooltip.Arrow className="fill-white dark:fill-[#1c1c1e]" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
};

export default CaptureInsightsButton;
