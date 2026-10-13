import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const TONES = {
  brand: "bg-primary-50/10 text-primary-50 dark:bg-primary-brand-dark/15 dark:text-primary-brand-dark",
  // Recording reads red wherever it appears (the tray's Record tile, the pill).
  record: "bg-[#FF3B30]/10 text-[#E5302A] dark:bg-[#FF453A]/15 dark:text-[#FF6961]",
  muted: "bg-grey-light-400 text-grey-50 dark:bg-black-300 dark:text-grey-dark-600",
} as const;

/**
 * The tinted square an icon sits in on the Screenshots & Recording tab, so
 * each setting is recognised by its icon before its words are read.
 */
export function SettingIcon({ tone = "brand", children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return (
    <span aria-hidden className={cn("grid size-8 flex-shrink-0 place-items-center rounded-[8px]", TONES[tone])}>
      {children}
    </span>
  );
}
