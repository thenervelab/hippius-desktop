import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { SettingsCard } from "./SettingsCard";
import { SettingIcon } from "./SettingIcon";

/**
 * One group of the Screenshots & Recording tab (Shortcuts, Saving,
 * Sharing, Recording): the settings card's label strip over rows divided
 * by hairlines, so the eye finds a group by its label and a setting by its
 * row instead of scanning a grid of equal cards.
 */
export function SettingGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <SettingsCard label={label}>
        <div className="divide-y divide-grey-dark-100 dark:divide-black-300">{children}</div>
      </SettingsCard>
    </section>
  );
}

/**
 * A setting's row: its icon, its name over one line of what it does, and
 * its control at the right edge, where every row's control lines up. A
 * `sub` row belongs to the row above it (it only means something while
 * that one is on) and is indented under that row's words, with its own
 * icon and the same background as every other row. A `wide`
 * control (a segmented choice) drops under the words on a narrow tab.
 */
export function SettingRow({
  icon,
  tone = "brand",
  title,
  description,
  control,
  below,
  sub = false,
  wide = false,
  group = false,
}: {
  icon?: ReactNode;
  tone?: "brand" | "record" | "muted";
  title: string;
  description?: ReactNode;
  control?: ReactNode;
  /** Under the words: an error, the upgrade prompt, a command to copy. */
  below?: ReactNode;
  sub?: boolean;
  wide?: boolean;
  /** Name the row as a group for assistive tech (and tests) by its title. */
  group?: boolean;
}) {
  return (
    <div
      role={group ? "group" : undefined}
      aria-label={group ? title : undefined}
      data-setting-row={sub ? "sub" : "top"}
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5",
        sub && "pl-[60px]",
      )}
    >
      <div className={cn("flex min-w-0 flex-1 items-start gap-3", wide ? "basis-[260px]" : "basis-[220px]")}>
        {icon && <SettingIcon tone={tone}>{icon}</SettingIcon>}
        <div className={cn("min-w-0", icon && "pt-[1px]")}>
          <p className="text-sm font-medium text-grey-10 dark:text-white">{title}</p>
          {description && (
            <p className="mt-0.5 text-[13px] leading-snug text-[#7D7D7D] dark:text-grey-dark-600">{description}</p>
          )}
          {below}
        </div>
      </div>
      {control && (
        <div className={cn("flex flex-shrink-0 flex-wrap items-center justify-end gap-2", wide && "max-sm:w-full")}>
          {control}
        </div>
      )}
    </div>
  );
}
