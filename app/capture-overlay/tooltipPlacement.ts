/**
 * Where the capture bar's tooltip goes, decided without the DOM so it can be
 * tested.
 *
 * The bar's buttons used native `title` tooltips. macOS draws those in a
 * window of their own, below the overlay window, which sits at the screen
 * saver level, so they showed behind the toolbar, and only after the
 * system's hover delay. The bar draws its own tooltip in the page instead
 * (`BarTooltip.tsx`), and this places it: above the button, centred on it,
 * below only when there is no room above, and always kept inside the
 * window.
 */

/** Space between the button and the tooltip. */
export const TIP_GAP = 8;

/** The closest the tooltip comes to the window's edges. */
export const TIP_EDGE = 8;

export interface TipBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TipPlacement {
  left: number;
  top: number;
  side: "above" | "below";
}

/**
 * The tooltip's top-left in the window, from the button's box, the
 * tooltip's own size and the window's size (all in CSS pixels). Above the
 * button when it fits there, else below it; centred on the button, then
 * moved in from an edge it would cross, and kept inside the window even
 * when neither side has room (Wayland's panel is fitted to the bar).
 */
export function placeTooltip(
  anchor: TipBox,
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
): TipPlacement {
  const above = anchor.top - TIP_GAP - tip.height;
  const side = above >= TIP_EDGE ? "above" : "below";
  const wanted = side === "above" ? above : anchor.top + anchor.height + TIP_GAP;
  const top = clamp(wanted, TIP_EDGE, viewport.height - TIP_EDGE - tip.height);
  const centred = anchor.left + anchor.width / 2 - tip.width / 2;
  const left = clamp(centred, TIP_EDGE, viewport.width - TIP_EDGE - tip.width);
  return { left, top, side };
}

/** `value` within [min, max], or `min` when the range is empty (a tooltip wider than the window starts at its edge). */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
