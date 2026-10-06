import type { CaptureWindowTarget, LogicalRect } from "@/app/lib/tauri/capture";

/**
 * Presentation maths for the capture overlay: turning pointer positions into
 * the rectangle it draws, and the window under the cursor into a highlight.
 * The CAPTURE maths — logical points to pixels, clamping, what counts as
 * nothing selected — is Rust's (`capture::geometry`); this only draws.
 */

export interface Point {
  x: number;
  y: number;
}

/** Below this, in points, a drag is a click that slipped, not a selection. */
const MIN_DRAG_POINTS = 4;

/** The rectangle between the press and the current pointer, in any direction. */
export function dragRect(start: Point, current: Point): LogicalRect {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

/**
 * A new area being dragged while Space is held moves instead of growing, as
 * in macOS's Cmd+Shift+4: both corners move by the pointer's step
 * (`dx`, `dy`), kept on the display. Returns the new start and current
 * corners.
 */
export function shiftDrag(
  start: Point,
  current: Point,
  dx: number,
  dy: number,
  bounds: { width: number; height: number },
): { start: Point; current: Point } {
  const rect = dragRect(start, current);
  const moved = moveRect(rect, dx, dy, bounds);
  const sx = moved.x - rect.x;
  const sy = moved.y - rect.y;
  return { start: { x: start.x + sx, y: start.y + sy }, current: { x: current.x + sx, y: current.y + sy } };
}

export function isRealDrag(rect: LogicalRect): boolean {
  return rect.width >= MIN_DRAG_POINTS && rect.height >= MIN_DRAG_POINTS;
}

/**
 * The window under `point`. Rust lists windows FRONT FIRST, so the first hit
 * is the one on top — a window behind another is never highlighted through it.
 */
export function windowAt(
  windows: readonly CaptureWindowTarget[],
  point: Point,
): CaptureWindowTarget | null {
  return (
    windows.find(
      (w) =>
        point.x >= w.x &&
        point.x < w.x + w.width &&
        point.y >= w.y &&
        point.y < w.y + w.height,
    ) ?? null
  );
}

/** "1280 × 720", in points — what the user framed, not the pixel count. */
export function sizeLabel(rect: LogicalRect): string {
  return `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
}

/** The eight handles on a drawn area, named by compass point. */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** How far from a handle's centre, in points, a press still grabs it. */
const HANDLE_GRAB = 9;

/** The smallest an area can be resized to, so it never folds inside out. */
const MIN_AREA = 16;

/** Where handle `h` sits on `rect`. */
export function handlePoint(rect: LogicalRect, h: Handle): Point {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  switch (h) {
    case "nw":
      return { x: rect.x, y: rect.y };
    case "n":
      return { x: cx, y: rect.y };
    case "ne":
      return { x: right, y: rect.y };
    case "e":
      return { x: right, y: cy };
    case "se":
      return { x: right, y: bottom };
    case "s":
      return { x: cx, y: bottom };
    case "sw":
      return { x: rect.x, y: bottom };
    case "w":
      return { x: rect.x, y: cy };
  }
}

/**
 * What a press at `point` grabs on `rect`: a handle (checked first, so the
 * corners win over the edges), the area itself to move it, or nothing, which
 * starts a new area.
 */
export function hitTest(rect: LogicalRect, point: Point): Handle | "move" | null {
  for (const h of HANDLES) {
    const p = handlePoint(rect, h);
    if (Math.abs(point.x - p.x) <= HANDLE_GRAB && Math.abs(point.y - p.y) <= HANDLE_GRAB) return h;
  }
  const inside =
    point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
  return inside ? "move" : null;
}

/** `rect` moved by (dx, dy), kept wholly on the display. */
export function moveRect(rect: LogicalRect, dx: number, dy: number, bounds: { width: number; height: number }): LogicalRect {
  return {
    ...rect,
    x: Math.min(Math.max(0, rect.x + dx), Math.max(0, bounds.width - rect.width)),
    y: Math.min(Math.max(0, rect.y + dy), Math.max(0, bounds.height - rect.height)),
  };
}

/**
 * `rect` with handle `h` dragged to `point`. The opposite side stays put, the
 * area never gets smaller than {@link MIN_AREA}, and it stays on the display.
 */
export function resizeRect(
  rect: LogicalRect,
  h: Handle,
  point: Point,
  bounds: { width: number; height: number },
): LogicalRect {
  const px = Math.min(Math.max(0, point.x), bounds.width);
  const py = Math.min(Math.max(0, point.y), bounds.height);
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (h.includes("w")) left = Math.min(px, right - MIN_AREA);
  if (h.includes("e")) right = Math.max(px, left + MIN_AREA);
  if (h.includes("n")) top = Math.min(py, bottom - MIN_AREA);
  if (h.includes("s")) bottom = Math.max(py, top + MIN_AREA);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * A remembered area, fitted to the display it is shown on now: a display
 * that shrank (resolution change) must not leave the area off screen.
 * `null` when nothing usable is left.
 */
export function fitRect(rect: LogicalRect, bounds: { width: number; height: number }): LogicalRect | null {
  const width = Math.min(rect.width, bounds.width);
  const height = Math.min(rect.height, bounds.height);
  if (width < MIN_AREA || height < MIN_AREA) return null;
  return moveRect({ x: rect.x, y: rect.y, width, height }, 0, 0, bounds);
}

/** How far one arrow press moves a drawn area, in points; Shift moves further. */
const NUDGE = 1;
const NUDGE_SHIFT = 10;

/**
 * `rect` moved by an arrow key, kept on the display, as macOS nudges a
 * selection: 1 pt a press, 10 pt with Shift. Null for any other key.
 */
export function nudgeRect(
  rect: LogicalRect,
  key: string,
  shift: boolean,
  bounds: { width: number; height: number },
): LogicalRect | null {
  const step = shift ? NUDGE_SHIFT : NUDGE;
  const delta: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const d = delta[key];
  return d ? moveRect(rect, d[0], d[1], bounds) : null;
}

/** `capture_pending_changed`: which display holds the area, and (when Rust sends it) the area. */
export interface PendingChange {
  displayId: number | null;
  rect?: LogicalRect | null;
}

/**
 * What one overlay draws after `capture_pending_changed`, mirroring Rust's
 * pending area. Events arrive in the order Rust applied them, so the last
 * one names the area the Capture button will take:
 *
 * - another display holds it: draw none here, and say an area exists;
 * - this display holds it: draw it, from the event's rect when Rust sends
 *   one, else the area this overlay last handed over. Keeping the current
 *   one instead left an overlay blank after a race with another display's
 *   restore, while Rust still held its area and would capture it unseen;
 * - nobody holds one: leave this overlay's drawing alone.
 *
 * `rect: undefined` means keep what is drawn.
 */
export function applyPending(
  own: number,
  change: PendingChange,
  lastHandedOver: LogicalRect | null,
): { rect: LogicalRect | null | undefined; elsewhere: boolean } {
  if (change.displayId === null) return { rect: undefined, elsewhere: false };
  if (change.displayId !== own) return { rect: null, elsewhere: true };
  return { rect: change.rect ?? lastHandedOver ?? undefined, elsewhere: false };
}
