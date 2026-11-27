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
// The quiet fill on the panel's background, the side panels' pill tone.
export const FILL = "bg-[#0000000A] dark:bg-white/[0.04]";
// A quiet card on the panel's background.
export const CARD = cn("rounded-[12px]", FILL);
// The hairline drawn as a ring, for boxes that sit flush in a column (the
// preview, the link field, the numbers), so it adds no width to them.
export const RING = "ring-1 ring-inset ring-grey-80 dark:ring-white/10";
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

// Charts: one look for every chart in the panels (where people stopped, time
// per page, a viewer's pages, a folder's pages). One baseline, a faint top
// line, soft fills, one value label, and the exact numbers on hover or focus.
/** Axis and value labels: the panel's small text, not a mono face. */
export const CHART_LABEL = cn("text-[11px] leading-4 tabular-nums", MUTED);
/** The chart's one solid line, at zero. */
export const CHART_BASELINE = "border-grey-80 dark:border-white/15";
/** The faint line at the top of the scale. */
export const CHART_TOPLINE = "border-grey-80/50 dark:border-white/[0.06]";
/** The series colour, as `currentColor`. */
export const CHART_INK = "text-primary-50 dark:text-primary-brand-dark";
/** A bar at rest, and the one under the pointer or keys. */
export const CHART_BAR = "bg-primary-50/30 dark:bg-primary-brand-dark/45";
export const CHART_BAR_ACTIVE = "bg-primary-50 dark:bg-primary-brand-dark";
/** A bar with nothing in it: a sliver on the baseline. */
export const CHART_BAR_EMPTY = "bg-grey-80 dark:bg-white/10";
/** The hover and focus readout. */
export const CHART_TOOLTIP = cn(
  "pointer-events-none absolute z-10 whitespace-nowrap rounded-[7px] px-2 py-1 text-[11.5px] font-medium tabular-nums shadow-sm",
  "bg-grey-10 text-white dark:bg-white dark:text-grey-10",
);
/** Keyboard focus on a chart: a ring clear of its marks. */
export const CHART_FOCUS = cn(
  "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary-50/40 focus-visible:ring-offset-4",
  "focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#1f1f1f]",
);
