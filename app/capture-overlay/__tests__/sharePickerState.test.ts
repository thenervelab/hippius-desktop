import { describe, expect, it } from "vitest";
import {
  displayCaption,
  gridStep,
  initialPick,
  livePick,
  mergeShareArt,
  selectionFor,
  tileAspect,
  windowCaption,
} from "@/app/capture-overlay/sharePickerState";
import type { ShareTargets } from "@/app/lib/tauri/capture";

const TARGETS: ShareTargets = {
  token: 7,
  pending: true,
  windows: [
    { id: 11, appName: "Safari", title: "Hippius", displayId: 1, width: 1200, height: 800, thumbnail: null, icon: null },
    { id: 12, appName: "Notes", title: "", displayId: 2, width: 600, height: 700, thumbnail: "data:old", icon: null },
  ],
  displays: [
    { id: 1, name: "Built-in Retina Display", isPrimary: true, width: 1512, height: 982, thumbnail: null },
    { id: 2, name: "Studio Display", isPrimary: false, width: 2560, height: 1440, thumbnail: null },
  ],
};

describe("pictures streaming into the share picker", () => {
  it("lands each picture on its own tile", () => {
    const next = mergeShareArt(TARGETS, {
      token: 7,
      items: [
        { tab: "window", id: 11, thumbnail: "data:w11", icon: "data:safari" },
        { tab: "screen", id: 2, thumbnail: "data:d2" },
      ],
    });
    expect(next.windows[0]).toMatchObject({ thumbnail: "data:w11", icon: "data:safari" });
    expect(next.displays[1].thumbnail).toBe("data:d2");
    // Untouched tiles keep what they had, and the input is not mutated.
    expect(next.windows[1].thumbnail).toBe("data:old");
    expect(TARGETS.windows[0].thumbnail).toBeNull();
  });

  /** A late batch from a picker that was closed and opened again. */
  it("ignores a batch from another picker", () => {
    expect(mergeShareArt(TARGETS, { token: 6, items: [{ tab: "window", id: 11, thumbnail: "data:x" }] })).toBe(TARGETS);
  });

  it("keeps an icon when a refresh brings only a new picture", () => {
    const withIcon = mergeShareArt(TARGETS, { token: 7, items: [{ tab: "window", id: 11, icon: "data:safari" }] });
    const refreshed = mergeShareArt(withIcon, { token: 7, items: [{ tab: "window", id: 11, thumbnail: "data:new" }] });
    expect(refreshed.windows[0]).toMatchObject({ thumbnail: "data:new", icon: "data:safari" });
  });

  it("drops pictures for windows no longer listed, without re-rendering", () => {
    expect(mergeShareArt(TARGETS, { token: 7, items: [{ tab: "window", id: 99, thumbnail: "data:x" }] })).toBe(TARGETS);
  });
});

describe("what the share picker shows and hands back", () => {
  it("captions a window by its title, with the app beneath", () => {
    expect(windowCaption({ title: "Hippius", appName: "Safari" })).toEqual({ title: "Hippius", app: "Safari" });
    // No title: the app name alone, not twice.
    expect(windowCaption({ title: "  ", appName: "Notes" })).toEqual({ title: "Notes", app: "" });
  });

  it("names screens, marking the main one", () => {
    expect(displayCaption(TARGETS.displays[0], 0)).toBe("Built-in Retina Display (main)");
    expect(displayCaption({ name: "", isPrimary: false }, 1)).toBe("Screen 2");
  });

  it("opens the screen tab on the bar's own screen, so Return shares it", () => {
    expect(initialPick("screen", TARGETS, 2)).toEqual({ tab: "screen", id: 2 });
    expect(initialPick("screen", TARGETS, 42)).toEqual({ tab: "screen", id: 1 });
  });

  it("opens the window tab on the frontmost window (Rust lists them front first)", () => {
    expect(initialPick("window", TARGETS, 2)).toEqual({ tab: "window", id: TARGETS.windows[0].id });
    expect(initialPick("window", { ...TARGETS, windows: [] }, 2)).toBeNull();
  });

  it("forgets a pick whose window has closed", () => {
    expect(livePick({ tab: "window", id: 11 }, TARGETS)).toEqual({ tab: "window", id: 11 });
    expect(livePick({ tab: "window", id: 99 }, TARGETS)).toBeNull();
  });

  /** The same `capture_select` a click on the overlay sends. */
  it("hands Rust a window by its id and a screen by its display id", () => {
    expect(selectionFor({ tab: "window", id: 11 })).toEqual({ target: "window", windowId: 11 });
    expect(selectionFor({ tab: "screen", id: 2 })).toEqual({ target: "screen", displayId: 2 });
  });

  it("keeps an odd window's placeholder within the grid's shapes", () => {
    expect(tileAspect(1600, 1000)).toBeCloseTo(1.6);
    expect(tileAspect(5000, 100)).toBe(2.4);
    expect(tileAspect(100, 5000)).toBe(0.75);
    expect(tileAspect(0, 0)).toBeCloseTo(1.6);
  });
});

describe("gridStep", () => {
  // Seven tiles, three across:  0 1 2 / 3 4 5 / 6
  it("moves a row with Up and Down and stays put at the edges", () => {
    expect(gridStep("ArrowDown", 1, 7, 3)).toBe(4);
    expect(gridStep("ArrowDown", 4, 7, 3)).toBe(4);
    expect(gridStep("ArrowDown", 3, 7, 3)).toBe(6);
    expect(gridStep("ArrowUp", 4, 7, 3)).toBe(1);
    expect(gridStep("ArrowUp", 1, 7, 3)).toBe(1);
  });

  it("walks the order with Left and Right, wrapping", () => {
    expect(gridStep("ArrowRight", 6, 7, 3)).toBe(0);
    expect(gridStep("ArrowLeft", 0, 7, 3)).toBe(6);
  });

  it("jumps to the ends with Home and End", () => {
    expect(gridStep("Home", 5, 7, 3)).toBe(0);
    expect(gridStep("End", 0, 7, 3)).toBe(6);
  });

  it("starts from an end when nothing is picked, and ignores other keys", () => {
    expect(gridStep("ArrowDown", -1, 7, 3)).toBe(0);
    expect(gridStep("ArrowUp", -1, 7, 3)).toBe(6);
    expect(gridStep("a", 2, 7, 3)).toBeNull();
    expect(gridStep("ArrowDown", 0, 0, 3)).toBeNull();
  });
});
