import { cn } from "@/lib/utils";

// The Insights panel's tokens: the app's own greys and brand blue, one border
// colour per theme (the side panels' own hairline), so every line in it matches.
export const MUTED = "text-grey-50 dark:text-grey-dark-600";
export const STRONG = "text-grey-10 dark:text-white";
export const HAIRLINE = "border-grey-80 dark:border-white/10";
export const DIVIDE = "divide-grey-80 dark:divide-white/10";
export const SKELETON = "animate-pulse rounded bg-grey-light-200 motion-reduce:animate-none dark:bg-black-500";
export const BAR_TRACK = "h-1 overflow-hidden rounded-full bg-grey-90 dark:bg-[#333]";
export const BAR_FILL = "h-full rounded-full bg-primary-50 dark:bg-primary-brand-dark";
// A quiet card on the panel's background, the side panels' pill tone.
export const CARD = "rounded-[12px] bg-[#0000000A] dark:bg-white/[0.04]";
export const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50/40";
export const TEXT_LINK = cn(
  "inline-flex items-center gap-1 rounded text-[12.5px] font-medium text-primary-50 hover:underline",
  FOCUS,
  "dark:text-primary-brand-dark",
);
/** A square icon button in the panel's header. */
export const ICON_BUTTON = cn(
  "flex size-[30px] shrink-0 items-center justify-center rounded-lg text-grey-50 transition-colors",
  "hover:bg-grey-90 hover:text-grey-10 dark:text-grey-dark-600 dark:hover:bg-white/10 dark:hover:text-white",
  FOCUS,
);
/** What floats over the panel: the comment menu and Link settings. */
export const FLOATING = cn("rounded-[12px] border bg-white shadow-lg dark:bg-[#1f1f1f]", HAIRLINE);
