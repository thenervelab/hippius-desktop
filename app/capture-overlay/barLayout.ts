import { GLASS_BAR, GLASS_PANEL, GLASS_PANEL_TIGHT, GLASS_PILL } from "@/app/lib/capture/glass";

/**
 * Where the capture bar is drawn.
 *
 * - `overlay`: on a full-screen overlay, bottom centre, its menus opening
 *   upward over the screen (macOS, Windows, X11).
 * - `panel`: alone in Wayland's recording panel, a window the page fits to
 *   the bar (`panelFit`). The bar sits at the window's top-left, which is
 *   the corner a resized Wayland window keeps still, so its menus open
 *   DOWNWARD and the window grows below the bar instead of the bar moving.
 *   Nothing is sized from the viewport there (it is the window being fitted,
 *   so `vh` / `vw` would chase their own tail), and shadows are tight so the
 *   window's edge never cuts one into a hard line.
 */
export type BarLayout = "overlay" | "panel";

export interface BarClasses {
  /** The bar's own column: hint, sources, toolbar. */
  column: string;
  /** The toolbar's glass. */
  toolbar: string;
  /** The sources panel's size and glass. */
  sources: string;
  /** The Options menu, placed against its button. */
  optionsMenu: string;
  /** A camera or microphone menu, placed against its row. */
  deviceMenu: string;
}

export function barClasses(layout: BarLayout): BarClasses {
  if (layout === "panel") {
    return {
      column: "relative flex flex-col items-center gap-2.5",
      toolbar: GLASS_PILL,
      sources: `w-[300px] ${GLASS_PILL}`,
      optionsMenu: `absolute top-[calc(100%+10px)] right-0 max-h-[360px] w-64 ${GLASS_PANEL_TIGHT}`,
      deviceMenu: `absolute top-[calc(100%+6px)] left-2 right-2 z-10 max-h-[280px] ${GLASS_PANEL_TIGHT}`,
    };
  }
  return {
    column: "absolute bottom-10 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2.5",
    toolbar: GLASS_BAR,
    sources: `w-[300px] max-w-[calc(100vw-32px)] ${GLASS_BAR}`,
    optionsMenu: `absolute bottom-[calc(100%+10px)] right-0 max-h-[60vh] w-64 ${GLASS_PANEL}`,
    deviceMenu: `absolute bottom-[calc(100%+6px)] left-2 right-2 z-10 max-h-[50vh] ${GLASS_PANEL}`,
  };
}
