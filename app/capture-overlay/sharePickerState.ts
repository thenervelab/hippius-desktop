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
 * What is picked when the picker opens, so Return shares it at once: on the
 * Entire screen tab the display the bar is on (else the main one); on the
 * Window tab the frontmost window (Rust lists windows front first), as Loom
 * does.
 */
export function initialPick(tab: ShareTab, targets: ShareTargets, barDisplayId: number): SharePick | null {
  if (tab === "window") {
    const front = targets.windows[0];
    return front ? { tab: "window", id: front.id } : null;
  }
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

/**
 * Where an arrow key moves the pick in a grid of `count` tiles laid out
 * `columns` across: Left / Right step through the order (wrapping), Up / Down
 * move a row and stay put at the top or bottom edge, Home / End jump to the
 * ends. Null for any other key. `at` of -1 (nothing picked) starts at the
 * first tile, or the last for Left / Up / End.
 */
export function gridStep(key: string, at: number, count: number, columns: number): number | null {
  if (count <= 0) return null;
  const cols = Math.max(1, Math.floor(columns));
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (at < 0) {
    if (key === "ArrowRight" || key === "ArrowDown") return 0;
    if (key === "ArrowLeft" || key === "ArrowUp") return count - 1;
    return null;
  }
  switch (key) {
    case "ArrowRight":
      return (at + 1) % count;
    case "ArrowLeft":
      return (at - 1 + count) % count;
    case "ArrowDown":
      return at + cols < count ? at + cols : at;
    case "ArrowUp":
      return at - cols >= 0 ? at - cols : at;
    default:
      return null;
  }
}
