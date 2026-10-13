import { useEffect } from "react";
import { fitCapturePanel } from "@/app/lib/tauri/capture";

/**
 * Wayland's recording panel is a window of its own, sized to what is in it:
 * the bar, its sources and any open menu. This measures that and hands the
 * size to Rust (`capture_panel_fit`), which sizes the window. The bar's
 * menus are absolutely placed, outside the bar's own box, so they are
 * measured as well as the bar. (Only the menus' own boxes: rows scrolled out
 * of a menu still report where they would be.)
 */

/** Clear space kept past the farthest edge drawn, for the tight shadows; the panel page places the bar this far in (`left-3 top-3`). */
export const PANEL_EDGE = 12;

interface Edges {
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * The window size that holds every drawn box (page coordinates from the
 * window's top-left), plus `edge` beyond the farthest. Boxes with no size
 * (hidden, or `sr-only` text) do not count. Null when nothing is drawn.
 */
export function panelExtent(boxes: Iterable<Edges>, edge = PANEL_EDGE): { width: number; height: number } | null {
  let right = 0;
  let bottom = 0;
  let any = false;
  for (const b of boxes) {
    if (b.width <= 1 || b.height <= 1) continue;
    any = true;
    right = Math.max(right, b.right);
    bottom = Math.max(bottom, b.bottom);
  }
  if (!any) return null;
  return { width: Math.ceil(right + edge), height: Math.ceil(bottom + edge) };
}

/** The root's box and every open menu's under it. */
function boxesUnder(root: HTMLElement): Edges[] {
  return [root, ...Array.from(root.querySelectorAll<HTMLElement>('[role="menu"]'))].map((el) =>
    el.getBoundingClientRect(),
  );
}

/**
 * Keep the panel's window fitted to what `root` draws while `enabled`:
 * again whenever anything under it changes size, appears or goes (a menu
 * opening, a device list arriving, the hint changing). The same size is
 * never sent twice in a row.
 */
export function usePanelFit(root: React.RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const el = root.current;
    if (!enabled || !el) return;
    let last = "";
    let frame = 0;
    const measure = () => {
      frame = 0;
      const size = panelExtent(boxesUnder(el));
      if (!size) return;
      const key = `${size.width}x${size.height}`;
      if (key === last) return;
      last = key;
      void fitCapturePanel(size.width, size.height).catch(() => {
        // Refused (the panel is going): the next change asks again.
        last = "";
      });
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(soon);
    resize?.observe(el);
    const mutation = new MutationObserver(soon);
    mutation.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize?.disconnect();
      mutation.disconnect();
    };
  }, [root, enabled]);
}
