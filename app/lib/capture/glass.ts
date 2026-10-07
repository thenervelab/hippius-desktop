/**
 * The dark glass every floating capture window is drawn in (the bar, its
 * menus, the share picker, the recording pill, the camera strip and the
 * preview card), in one place so the surfaces stay one material.
 *
 * Fixed rather than themed: these windows float over OTHER apps, not over
 * Hippius, so the app's light or dark setting says nothing about what is
 * underneath. Two alphas only: 85 percent for the bar and the pill, which
 * sit on the dimmed overlay or the user's own screen and should let it
 * through a little; 95 percent for menus, the picker and the card, which
 * hold text that has to stay readable whatever is behind them.
 *
 * Text on the glass is never fainter than white/60 (5.8:1 or better on the
 * base colour); /40 and /45 are for icons and separators only.
 */

/** The one blue: buttons, rings, the picked tile and the card's progress. */
export const CAPTURE_ACCENT = "#3167DD";

/** The glass's own base colour, which focus-ring offsets are drawn in. */
export const GLASS_BASE = "#1c1d21";

/** Keyboard focus on the glass: a blue ring that reads apart from the pressed state. */
export const GLASS_FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-[#3167DD] focus-visible:ring-offset-1 focus-visible:ring-offset-[#1c1d21]";

/** The bar, the sources panel and the recording pill. */
export const GLASS_BAR =
  "border border-white/10 bg-[#1c1d21]/85 text-white shadow-[0_14px_36px_rgba(0,0,0,0.45)] backdrop-blur-xl";

/**
 * The recording pill: the bar's glass with a shadow that fits its window.
 * The pill's window leaves about 9px around it, and a window clips whatever
 * is drawn past its edge, so the bar's 50px shadow was cut into a hard-edged
 * dark rectangle around the pill. This one reaches at most 8px.
 */
export const GLASS_PILL =
  "border border-white/10 bg-[#1c1d21]/85 text-white shadow-[0_2px_6px_rgba(0,0,0,0.35)] backdrop-blur-xl";

/** Menus, the share picker and the preview card. */
export const GLASS_PANEL =
  "border border-white/10 bg-[#1c1d21]/95 text-white shadow-[0_18px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl";

/**
 * Menus in a window fitted to its content (Wayland's recording panel): the
 * menu glass with the pill's tight shadow, which the window's edge does not
 * cut into a hard line.
 */
export const GLASS_PANEL_TIGHT =
  "border border-white/10 bg-[#1c1d21]/95 text-white shadow-[0_2px_6px_rgba(0,0,0,0.35)] backdrop-blur-xl";

/** A plain button on the glass (icon or text). */
export const GLASS_BUTTON = `text-white/85 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 ${GLASS_FOCUS}`;

/** The main action on the glass: Capture, Record, Show in folder. */
export const GLASS_PRIMARY = `bg-[#3167DD] font-semibold text-white transition-colors hover:bg-[#2a5bc6] disabled:cursor-not-allowed disabled:opacity-45 ${GLASS_FOCUS}`;

/** An inline text action on the glass, inside a caption ("Open Settings"). */
export const GLASS_LINK = `rounded-[4px] font-semibold text-white underline underline-offset-2 hover:text-white/85 ${GLASS_FOCUS}`;

/** Secondary text on the glass: captions, headings, "Default". */
export const GLASS_MUTED = "text-white/60";
