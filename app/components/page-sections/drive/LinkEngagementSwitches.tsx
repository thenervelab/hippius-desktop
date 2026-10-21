"use client";

import { useState } from "react";
import { BarChart3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsToggle } from "@/app/components/page-sections/settings/SettingsToggle";
import type { LinkSettings, OfferedSwitches } from "@/app/lib/tauri/shareInsights";
import {
  LOCKED_ACTION,
  LOCKED_PROMPT,
  SWITCH_UPGRADE_BODY,
} from "@/components/page-sections/shares/insights/insightsView";

/** The words for each switch, in the order they are shown. */
export const LINK_SWITCHES: ReadonlyArray<{
  key: keyof LinkSettings;
  label: string;
  description: string;
}> = [
  { key: "insights", label: "Insights", description: "See who viewed it and for how long." },
  { key: "comments", label: "Comments", description: "Let viewers leave comments." },
  { key: "reactions", label: "Reactions", description: "Let viewers react with emoji." },
];

/** The Insights switch's line while the plan does not include it. */
export const INSIGHTS_LOCKED_DESCRIPTION = "Count views and watch time. On paid Drive plans.";

/**
 * A link's Insights, Comments and Reactions switches, in the share dialog,
 * on the finished link and in the Insights sheet. Only the switches Rust says
 * this server takes (`offered`) are drawn; with none, nothing is.
 *
 * `insightsInPlan` is Rust's answer (`false` on the free plan). On the free
 * plan, turning Insights on shows the upgrade prompt instead of turning the
 * switch on; a link that already has Insights on keeps them and can still
 * turn them off. A plan that could not be read (`null`) locks nothing: the
 * switch works, and Rust still starts a new link's Insights off.
 */
export default function LinkEngagementSwitches({
  offered,
  value,
  disabled = false,
  insightsInPlan = null,
  onChange,
  onUpgrade,
}: {
  offered: OfferedSwitches;
  value: LinkSettings;
  disabled?: boolean;
  insightsInPlan?: boolean | null;
  onChange: (next: LinkSettings) => void;
  /** Opens the plans page (and closes whatever this sits in). */
  onUpgrade: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const shown = LINK_SWITCHES.filter((s) => offered[s.key]);
  if (shown.length === 0) return null;
  const locked = insightsInPlan === false;
  return (
    <div className="mt-3 flex flex-col gap-2" role="group" aria-label="Viewer activity">
      {shown.map(({ key, label, description }) => {
        return (
          <div key={key} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">{label}</p>
              <p className="text-xs text-grey-50 dark:text-grey-dark-600">
                {key === "insights" && locked ? INSIGHTS_LOCKED_DESCRIPTION : description}
              </p>
            </div>
            <SettingsToggle
              ariaLabel={label}
              checked={value[key]}
              disabled={disabled}
              onCheckedChange={(on) => {
                if (key === "insights" && on && locked) {
                  setAsking(true);
                  return;
                }
                onChange({ ...value, [key]: on });
              }}
            />
          </div>
        );
      })}
      <div aria-live="polite">
        {asking && locked && <InsightsUpgradeNotice onUpgrade={onUpgrade} />}
      </div>
    </div>
  );
}

/**
 * The upgrade card for Insights on the free plan, in the Insights sheet's
 * locked words (`insightsView`, the same as the web app's). A card, not a warning:
 * nothing is wrong, the plan just does not include it. Stacks on a narrow
 * container, one row on a wide one.
 */
export function InsightsUpgradeNotice({
  onUpgrade,
  className,
}: {
  onUpgrade: () => void;
  className?: string;
}) {
  return (
    <div className={cn("@container", className)}>
      <div
        role="region"
        aria-label="Upgrade for Insights"
        className="flex flex-col gap-3 rounded-lg border border-primary-50/25 bg-primary-50/[0.06] p-3 @md:flex-row @md:items-center dark:border-primary-50/30 dark:bg-primary-50/10"
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-50/10 text-primary-50 dark:bg-primary-50/15 dark:text-primary-brand-dark"
          >
            <BarChart3 className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="break-words text-[13px] font-medium leading-5 text-grey-10 dark:text-white">
              {LOCKED_PROMPT}
            </p>
            <p className="mt-0.5 break-words text-xs leading-5 text-grey-40 dark:text-grey-dark-600">
              {SWITCH_UPGRADE_BODY}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="primary"
          size="auto"
          onClick={onUpgrade}
          className="h-[34px] w-full shrink-0 whitespace-nowrap rounded-[8px] px-4 text-[13px] font-medium @md:w-auto"
        >
          {LOCKED_ACTION}
        </Button>
      </div>
    </div>
  );
}
