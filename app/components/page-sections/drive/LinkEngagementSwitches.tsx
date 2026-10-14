"use client";

import { SettingsToggle } from "@/app/components/page-sections/settings/SettingsToggle";
import type { LinkSettings, OfferedSwitches } from "@/app/lib/tauri/shareInsights";

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

/**
 * A link's Insights, Comments and Reactions switches, in the share dialog
 * and on the finished link. Only the switches Rust says this server takes
 * (`offered`) are drawn; with none, nothing is.
 */
export default function LinkEngagementSwitches({
  offered,
  value,
  disabled = false,
  onChange,
}: {
  offered: OfferedSwitches;
  value: LinkSettings;
  disabled?: boolean;
  onChange: (next: LinkSettings) => void;
}) {
  const shown = LINK_SWITCHES.filter((s) => offered[s.key]);
  if (shown.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2" role="group" aria-label="Viewer activity">
      {shown.map(({ key, label, description }) => (
        <div key={key} className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">{label}</p>
            <p className="text-xs text-grey-50 dark:text-grey-dark-600">{description}</p>
          </div>
          <SettingsToggle
            ariaLabel={label}
            checked={value[key]}
            disabled={disabled}
            onCheckedChange={(on) => onChange({ ...value, [key]: on })}
          />
        </div>
      ))}
    </div>
  );
}
