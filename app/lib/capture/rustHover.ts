/**
 * Hover for the floating capture windows that are never the key window: the
 * recording pill, the camera bubble's controls and the preview card.
 *
 * They must not take the keyboard from the app the user is in (or is
 * recording), and WebKit on macOS turns mouse moves into hover only for the
 * key window. So in these windows no `:hover`, no `pointerenter` and no
 * native `title` tooltip ever happens until the user clicks. Rust reads the
 * pointer instead (its watch, or a command the page asks) and hands the page
 * the point; the page finds the element under it here. Windows delivers
 * hover to an unfocused window, but these windows take the same path there,
 * so every platform behaves the same.
 */

/** A point in a window, in CSS pixels from the top left of `origin`. */
export interface HoverPoint {
  x: number;
  y: number;
}

/** What the point is measured from, in the page's own CSS pixels. */
export interface HoverOrigin {
  left: number;
  top: number;
}

/** The page's hit test (`document.elementFromPoint`), injectable for tests. */
export type HitTest = (x: number, y: number) => Element | null;

const pageHitTest: HitTest = (x, y) =>
  typeof document !== "undefined" &&
  typeof document.elementFromPoint === "function"
    ? document.elementFromPoint(x, y)
    : null;

/**
 * The element marked with `attribute` (a `data-*` name) under `point`, or
 * null. The point is relative to `origin` (the pill's row, say); the page's
 * hit test takes page coordinates, so the origin is added back.
 * `pointer-events: none` elements (a tooltip) are skipped by the hit test.
 */
export function markedAt(
  point: HoverPoint | null,
  origin: HoverOrigin,
  attribute: string,
  hit: HitTest = pageHitTest,
): Element | null {
  if (!point) return null;
  const el = hit(origin.left + point.x, origin.top + point.y);
  // An icon (SVG) counts as much as a button.
  return el?.closest(`[${attribute}]`) ?? null;
}

/** `box` relative to `origin`, for Rust to place a tooltip against. */
export function boxFrom(
  box: DOMRect | { left: number; top: number; width: number; height: number },
  origin: HoverOrigin,
) {
  return {
    left: box.left - origin.left,
    top: box.top - origin.top,
    width: box.width,
    height: box.height,
  };
}
