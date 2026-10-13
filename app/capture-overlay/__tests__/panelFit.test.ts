import { describe, expect, it } from "vitest";
import { barClasses } from "../barLayout";
import { PANEL_EDGE, panelExtent } from "../panelFit";

const box = (left: number, top: number, width: number, height: number) => ({
  width,
  height,
  right: left + width,
  bottom: top + height,
});

describe("the panel's fitted size", () => {
  it("holds the bar and an open menu, with the edge past the farthest of them", () => {
    expect(panelExtent([box(12, 12, 480, 200)])).toEqual({ width: 480 + 12 + PANEL_EDGE, height: 212 + PANEL_EDGE });
    // A menu hanging below the bar grows it downward only.
    expect(panelExtent([box(12, 12, 480, 200), box(236, 222, 256, 140)])).toEqual({ width: 504, height: 374 });
    // A wider menu widens it.
    expect(panelExtent([box(12, 12, 300, 100), box(12, 120, 420, 60)])).toEqual({ width: 444, height: 192 });
  });

  it("rounds a fractional layout up, so nothing is cut by part of a pixel", () => {
    expect(panelExtent([box(12, 12, 480.2, 199.6)])).toEqual({ width: 505, height: 224 });
  });

  it("ignores boxes with no size and has nothing to say when nothing is drawn", () => {
    expect(panelExtent([box(12, 12, 480, 200), box(900, 900, 1, 1), box(900, 900, 0, 40)])).toEqual({
      width: 504,
      height: 224,
    });
    expect(panelExtent([])).toBeNull();
    expect(panelExtent([box(0, 0, 0, 0)])).toBeNull();
  });
});

describe("where the bar draws itself", () => {
  /**
   * In the fitted panel the window grows from its top-left, so the menus
   * open below; nothing is sized from the viewport (the window being
   * fitted), and the shadows stay within the clear edge.
   */
  it("opens its menus downward in the panel, sized in pixels, with tight shadows", () => {
    const panel = barClasses("panel");
    for (const menu of [panel.optionsMenu, panel.deviceMenu]) {
      expect(menu).toMatch(/\btop-\[calc\(100%\+\d+px\)\]/);
      expect(menu).not.toMatch(/\bbottom-/);
      expect(menu).not.toMatch(/v[hw]\b|v[hw]\)/);
      expect(menu).toContain("shadow-[0_2px_6px");
    }
    expect(panel.column).not.toMatch(/absolute|bottom-|translate/);
    expect(panel.sources).not.toMatch(/vw/);
    expect(panel.toolbar).toContain("shadow-[0_2px_6px");
  });

  /**
   * A device menu in the panel drops over the toolbar below its row. The
   * glass makes the sources panel and the toolbar stacking contexts painted
   * in page order, so without a z-index of its own the sources panel (and
   * the menu in it) was drawn under the toolbar.
   */
  it("lifts the panel's sources, and their menus, above the toolbar", () => {
    const panel = barClasses("panel");
    expect(panel.sources).toMatch(/(^|\s)relative(\s|$)/);
    expect(panel.sources).toMatch(/(^|\s)z-20(\s|$)/);
    expect(panel.toolbar).not.toMatch(/(^|\s)z-/);
    // The overlay's menus open upward, away from the toolbar: unchanged.
    expect(barClasses("overlay").sources).not.toMatch(/(^|\s)z-/);
  });

  it("keeps the overlay's bar at the bottom of the screen with its menus above", () => {
    const overlay = barClasses("overlay");
    expect(overlay.column).toContain("bottom-10");
    expect(overlay.optionsMenu).toContain("bottom-[calc(100%+10px)]");
    expect(overlay.deviceMenu).toContain("bottom-[calc(100%+6px)]");
  });
});
