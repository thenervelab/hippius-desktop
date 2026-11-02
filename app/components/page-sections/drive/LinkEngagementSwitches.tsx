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

/**
 * The words for each switch, in the order they are shown. `locked` is the
 * line while the plan does not include it.
 */
export const LINK_SWITCHES: ReadonlyArray<{
  key: keyof LinkSettings;
  label: string;
  description: string;
  locked: string;
}> = [
  {
    key: "insights",
    label: "Insights",
    description: "Count views and watch time. Viewers see a short note.",
    locked: "Count views and watch time. On paid Drive plans.",
  },
  {
    key: "comments",
    label: "Comments",
    description: "Let viewers comment on this link.",
    locked: "Let viewers comment on this link. On paid Drive plans.",
  },
  {
    key: "reactions",
    label: "Reactions",
    description: "Let viewers react with emoji.",
    locked: "Let viewers react with emoji. On paid Drive plans.",
  },
];

/**
 * Under the switches on the free plan while one is on: turning it off is
 * allowed, turning it back on is not.
 */
export const FREE_OFF_NOTE = "On the free plan, a switch you turn off can't be turned back on unless you upgrade.";

/** The Insights switch's line while the plan does not include it. */
export const INSIGHTS_LOCKED_DESCRIPTION = LINK_SWITCHES[0].locked;

/**
 * A link's Insights, Comments and Reactions switches, in the share dialog,
 * on the finished link and in the Insights sheet. Only the switches Rust says
 * this server takes (`offered`) are drawn; with none, nothing is.
 *
 * `switchesInPlan` is Rust's answer (`false` on the free plan). On the free
 * plan, turning any switch on shows the upgrade prompt instead of turning it
 * on; a link that already has one on keeps it and can still turn it off. A
 * plan that could not be read (`null`) locks nothing: the switches work, and
 * Rust still starts a new link's switches off.
 */
export default function LinkEngagementSwitches({
  offered,
  value,
  disabled = false,
  switchesInPlan = null,
  onChange,
  onUpgrade,
  layout = "stack",
}: {
  /**
   * `stack` (the share dialog): rows one under another. `list` (the Insights
   * sheet's "On this link"): a bordered list, one row per switch.
   */
  layout?: "stack" | "list";
  offered: OfferedSwitches;
  value: LinkSettings;
  disabled?: boolean;
  switchesInPlan?: boolean | null;
  onChange: (next: LinkSettings) => void;
  /** Opens the plans page (and closes whatever this sits in). */
  onUpgrade: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const shown = LINK_SWITCHES.filter((s) => offered[s.key]);
  if (shown.length === 0) return null;
  const locked = switchesInPlan === false;
  const list = layout === "list";
  return (
    <div className={cn("flex flex-col", !list && "mt-3 gap-2")} role="group" aria-label="Viewer activity">
      <div
        className={cn(
          "flex flex-col",
          list
            ? "divide-y divide-grey-80 rounded-[12px] border border-grey-80 dark:divide-[#333] dark:border-[#494949]"
            : "gap-2",
        )}
      >
        {shown.map(({ key, label, description, locked: lockedDescription }) => {
          return (
            <div key={key} className={cn("flex items-center justify-between gap-3", list && "px-3 py-2.5")}>
              <div className="min-w-0">
                <p
                  className={cn(
                    "font-medium",
                    list ? "text-[13px] text-grey-10 dark:text-white" : "text-xs text-grey-30 dark:text-grey-dark-700",
                  )}
                >
                  {label}
                </p>
                <p className="text-xs text-grey-50 dark:text-grey-dark-600">
                  {locked ? lockedDescription : description}
                </p>
              </div>
              <SettingsToggle
                ariaLabel={label}
                checked={value[key]}
                disabled={disabled}
                onCheckedChange={(on) => {
                  if (on && locked) {
                    setAsking(true);
                    return;
                  }
                  onChange({ ...value, [key]: on });
                }}
              />
            </div>
          );
        })}
      </div>
      {/* On the free plan an older link can keep a switch it has on, but one
          turned off cannot come back without upgrading: say so before it is. */}
      {locked && shown.some(({ key }) => value[key]) && (
        <p className={cn("text-xs leading-[1.45] text-grey-50 dark:text-grey-dark-600", list && "mt-2.5")}>
          {FREE_OFF_NOTE}
        </p>
      )}
      <div aria-live="polite">
        {asking && locked && <SwitchesUpgradeNotice onUpgrade={onUpgrade} className={list ? "mt-3" : undefined} />}
      </div>
    </div>
  );
}

/** The upgrade card's accessible name. */
export const UPGRADE_NOTICE_LABEL = "Upgrade for Insights, comments and reactions";

/**
 * The upgrade card for the link switches on the free plan, in the Insights
 * sheet's locked words (`insightsView`, the same as the web app's): in the
 * share dialog, on the finished link, in the Insights sheet and in Settings.
 * A card, not a warning: nothing is wrong, the plan just does not include
 * them. Stacks on a narrow container, one row on a wide one.
 */
export function SwitchesUpgradeNotice({
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
        aria-label={UPGRADE_NOTICE_LABEL}
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
