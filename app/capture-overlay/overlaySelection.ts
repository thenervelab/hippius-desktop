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
export const MIN_DRAG_POINTS = 4;

/** The rectangle between the press and the current pointer, in any direction. */
export function dragRect(start: Point, current: Point): LogicalRect {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
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
