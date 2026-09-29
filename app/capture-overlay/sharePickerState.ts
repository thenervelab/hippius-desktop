import type { CaptureSelection, ShareArt, ShareDisplay, ShareTab, ShareTargets, ShareWindow } from "@/app/lib/tauri/capture";

/**
 * "Choose what to share", decided without React so it can be tested: how a
 * batch of pictures lands, what each tile is called, and what choosing it
 * hands to Rust. Rust decides what is listed (`capture::share`).
 */

/** A picked tile: which tab it is on and its id there. */
export interface SharePick {
  tab: ShareTab;
  id: number;
}

/**
 * Fold a `capture_share_art` batch into the list. A batch from another picker
 * (a stale token) is ignored, and an item that is no longer listed is
 * dropped. Returns the same object when nothing changed, so React skips the
 * render.
 */
export function mergeShareArt(targets: ShareTargets, art: ShareArt): ShareTargets {
  if (art.token !== targets.token || art.items.length === 0) return targets;
  let windows = targets.windows;
  let displays = targets.displays;
  for (const item of art.items) {
    if (item.tab === "window") {
      const i = windows.findIndex((w) => w.id === item.id);
      if (i < 0) continue;
      const w = windows[i];
      const next: ShareWindow = {
        ...w,
        thumbnail: item.thumbnail ?? w.thumbnail,
        icon: item.icon ?? w.icon,
      };
      if (next.thumbnail === w.thumbnail && next.icon === w.icon) continue;
      if (windows === targets.windows) windows = [...windows];
      windows[i] = next;
    } else {
      const i = displays.findIndex((d) => d.id === item.id);
      if (i < 0 || !item.thumbnail || item.thumbnail === displays[i].thumbnail) continue;
      if (displays === targets.displays) displays = [...displays];
      displays[i] = { ...displays[i], thumbnail: item.thumbnail };
    }
  }
  if (windows === targets.windows && displays === targets.displays) return targets;
  return { ...targets, windows, displays };
}

/** A window tile's caption: its title, with the app's name under it. */
export function windowCaption(w: Pick<ShareWindow, "title" | "appName">): { title: string; app: string } {
  const title = w.title.trim() || w.appName.trim() || "Window";
  const app = w.appName.trim();
  return { title, app: app === title ? "" : app };
}

/** A display tile's caption; the main display says so. */
export function displayCaption(d: Pick<ShareDisplay, "name" | "isPrimary">, index: number): string {
  const name = d.name.trim() || `Screen ${index + 1}`;
  return d.isPrimary ? `${name} (main)` : name;
}

/**
 * What is picked when the picker opens: on the Entire Screen tab the display
 * the bar is on (else the main one), so Return shares it at once; on the
 * Window tab nothing, as a window has to be chosen.
 */
export function initialPick(tab: ShareTab, targets: ShareTargets, barDisplayId: number): SharePick | null {
  if (tab === "window") return null;
  const d =
    targets.displays.find((x) => x.id === barDisplayId) ??
    targets.displays.find((x) => x.isPrimary) ??
    targets.displays[0];
  return d ? { tab: "screen", id: d.id } : null;
}

/** A pick still on the list, or null (its window closed since). */
export function livePick(pick: SharePick | null, targets: ShareTargets): SharePick | null {
  if (!pick) return null;
  const list = pick.tab === "window" ? targets.windows : targets.displays;
  return list.some((x) => x.id === pick.id) ? pick : null;
}

/** What choosing a tile hands to `capture_select`. */
export function selectionFor(pick: SharePick): CaptureSelection {
  return pick.tab === "window" ? { target: "window", windowId: pick.id } : { target: "screen", displayId: pick.id };
}

/**
 * The tile's picture box shape (width / height) before its picture arrives,
 * kept between square-ish and very wide so one odd window does not break
 * the grid.
 */
export function tileAspect(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 16 / 10;
  return Math.min(Math.max(width / height, 0.75), 2.4);
}
