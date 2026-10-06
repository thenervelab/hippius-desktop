import type { Point, Rect } from "./model";

/**
 * Crop math and the mapping between the picture's pixels and the screen.
 * Pure, so the arithmetic that decides what is exported is tested alone.
 */

export interface AspectPreset {
  id: string;
  label: string;
  /** Width over height; `null` = freeform, `"original"` = the picture's own. */
  ratio: number | null | "original";
}

export const ASPECT_PRESETS: AspectPreset[] = [
  { id: "free", label: "Freeform", ratio: null },
  { id: "original", label: "Original", ratio: "original" },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
];

export function resolveRatio(preset: AspectPreset, imageW: number, imageH: number): number | null {
  if (preset.ratio === "original") return imageH > 0 ? imageW / imageH : null;
  return preset.ratio;
}

/**
 * `r` inside the picture, in whole pixels, at least 1 x 1: the exported
 * PNG is exactly this many pixels, so a fraction would blur its edges.
 */
export function clampCrop(r: Rect, imageW: number, imageH: number): Rect {
  const x0 = Math.max(0, Math.min(imageW - 1, Math.round(r.x)));
  const y0 = Math.max(0, Math.min(imageH - 1, Math.round(r.y)));
  const x1 = Math.max(x0 + 1, Math.min(imageW, Math.round(r.x + r.w)));
  const y1 = Math.max(y0 + 1, Math.min(imageH, Math.round(r.y + r.h)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The crop dragged from `start` to `current`, held to `ratio` when one is
 * chosen (the height follows the width, toward the pointer) and kept inside
 * the picture. Returns null for a drag too small to be a crop.
 */
export function cropFromDrag(start: Point, current: Point, ratio: number | null, imageW: number, imageH: number): Rect | null {
  let dx = current.x - start.x;
  let dy = current.y - start.y;
  if (ratio !== null && ratio > 0) {
    const h = Math.abs(dx) / ratio;
    dy = Math.sign(dy || 1) * h;
  }
  // Keep the drag inside the picture before rounding, so a ratio survives.
  const maxDx = dx >= 0 ? imageW - start.x : -start.x;
  const maxDy = dy >= 0 ? imageH - start.y : -start.y;
  const fx = dx === 0 ? 1 : Math.min(1, maxDx / dx);
  const fy = dy === 0 ? 1 : Math.min(1, maxDy / dy);
  const f = ratio !== null ? Math.min(fx, fy) : 1;
  dx = ratio !== null ? dx * f : dx * fx;
  dy = ratio !== null ? dy * f : dy * fy;
  if (Math.abs(dx) < 4 || Math.abs(dy) < 4) return null;
  const r = { x: Math.min(start.x, start.x + dx), y: Math.min(start.y, start.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
  return clampCrop(r, imageW, imageH);
}

/** An existing crop given `ratio`: the largest rectangle of that shape inside it, centred. */
export function fitCropToRatio(r: Rect, ratio: number | null, imageW: number, imageH: number): Rect {
  if (ratio === null || ratio <= 0) return clampCrop(r, imageW, imageH);
  let w = r.w;
  let h = w / ratio;
  if (h > r.h) {
    h = r.h;
    w = h * ratio;
  }
  return clampCrop({ x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h }, imageW, imageH);
}

/** A crop moved by (dx, dy), stopped at the picture's edges. */
export function moveCrop(r: Rect, dx: number, dy: number, imageW: number, imageH: number): Rect {
  const x = Math.max(0, Math.min(imageW - r.w, r.x + dx));
  const y = Math.max(0, Math.min(imageH - r.h, r.y + dy));
  return clampCrop({ ...r, x, y }, imageW, imageH);
}

/** How `region` of the picture sits in a `viewW` x `viewH` box. */
export interface View {
  region: Rect;
  /** Screen points per picture pixel. */
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Fit `region` in the box with `padding` around it, never enlarged past its
 * natural size on this screen (`devicePixelRatio` picture pixels per point),
 * so a small screenshot is not blown up into a blur.
 */
export function fitView(region: Rect, viewW: number, viewH: number, padding: number, devicePixelRatio = 1): View {
  const availW = Math.max(1, viewW - padding * 2);
  const availH = Math.max(1, viewH - padding * 2);
  const natural = 1 / Math.max(devicePixelRatio, 1);
  const scale = Math.min(availW / Math.max(region.w, 1), availH / Math.max(region.h, 1), natural);
  return {
    region,
    scale,
    offsetX: (viewW - region.w * scale) / 2,
    offsetY: (viewH - region.h * scale) / 2,
  };
}

export function toImage(view: View, p: Point): Point {
  return { x: view.region.x + (p.x - view.offsetX) / view.scale, y: view.region.y + (p.y - view.offsetY) / view.scale };
}

export function toScreen(view: View, p: Point): Point {
  return { x: view.offsetX + (p.x - view.region.x) * view.scale, y: view.offsetY + (p.y - view.region.y) * view.scale };
}

/**
 * One unit of stroke for this picture: strokes and text are sized in
 * picture pixels, so they look the same weight on a small window shot and
 * on a whole Retina screen.
 */
export function strokeUnit(imageW: number, imageH: number): number {
  return Math.max(1, Math.round(Math.max(imageW, imageH) / 1000));
}

/** Pixelate block (and blur strength) for this picture, in picture pixels. */
export function redactionBlock(imageW: number, imageH: number): number {
  return Math.max(8, Math.round(Math.max(imageW, imageH) / 120));
}
