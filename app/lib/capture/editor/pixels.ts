import type { Rect } from "./model";

/**
 * Blur and pixelate, written into the picture's own pixels.
 *
 * These run on the exported image's RGBA buffer BEFORE it is encoded, so the
 * saved PNG holds the scrambled pixels and nothing else: there is no layer a
 * viewer could remove. Pixelate replaces each block with its average, so the
 * detail inside a block is gone. Blur pixelates first and then smooths the
 * blocks: a plain blur of text can be partly undone (deconvolution), a blur
 * of block averages cannot bring back what the averaging threw away.
 */

/** The parts of an `ImageData` these functions use, so tests need no canvas. */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** `r` in whole pixels inside the buffer, or null when nothing of it is. */
export function pixelBox(r: Rect, width: number, height: number): { x0: number; y0: number; x1: number; y1: number } | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.w));
  const y1 = Math.min(height, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/** Replace every `block` x `block` square inside `r` with its average colour. */
export function pixelate(px: Pixels, r: Rect, block: number): void {
  const box = pixelBox(r, px.width, px.height);
  if (!box) return;
  const size = Math.max(2, Math.round(block));
  const { data, width } = px;
  for (let by = box.y0; by < box.y1; by += size) {
    for (let bx = box.x0; bx < box.x1; bx += size) {
      const ex = Math.min(bx + size, box.x1);
      const ey = Math.min(by + size, box.y1);
      let r0 = 0;
      let g0 = 0;
      let b0 = 0;
      let a0 = 0;
      let n = 0;
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * width + x) * 4;
          r0 += data[i];
          g0 += data[i + 1];
          b0 += data[i + 2];
          a0 += data[i + 3];
          n++;
        }
      }
      const avg = [r0 / n, g0 / n, b0 / n, a0 / n];
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * width + x) * 4;
          data[i] = avg[0];
          data[i + 1] = avg[1];
          data[i + 2] = avg[2];
          data[i + 3] = avg[3];
        }
      }
    }
  }
}

/**
 * Blur inside `r`: pixelate at half the strength, then three box-blur
 * passes each way (close to a Gaussian). Only pixels inside `r` change;
 * the smoothing reads only inside `r` too, so nothing from outside the box
 * bleeds in and the box's edge stays where it was drawn.
 */
export function blur(px: Pixels, r: Rect, strength: number): void {
  const box = pixelBox(r, px.width, px.height);
  if (!box) return;
  pixelate(px, r, Math.max(2, Math.round(strength / 2)));
  const radius = Math.max(1, Math.round(strength / 2));
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const buf = new Float32Array(w * h * 4);
  const { data, width } = px;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((box.y0 + y) * width + (box.x0 + x)) * 4;
      const dst = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) buf[dst + c] = data[src + c];
    }
  }
  const tmp = new Float32Array(buf.length);
  for (let pass = 0; pass < 3; pass++) {
    boxPass(buf, tmp, w, h, radius, true);
    boxPass(tmp, buf, w, h, radius, false);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dst = ((box.y0 + y) * width + (box.x0 + x)) * 4;
      const src = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) data[dst + c] = buf[src + c];
    }
  }
}

/** One running-average pass along rows (`horizontal`) or columns, edges clamped. */
function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, radius: number, horizontal: boolean): void {
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const at = (line: number, i: number) => (horizontal ? (line * w + i) * 4 : (i * w + line) * 4);
  const span = radius * 2 + 1;
  for (let line = 0; line < lines; line++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += src[at(line, Math.min(len - 1, Math.max(0, k))) + c];
      for (let i = 0; i < len; i++) {
        dst[at(line, i) + c] = sum / span;
        const out = Math.max(0, i - radius);
        const inn = Math.min(len - 1, i + radius + 1);
        sum += src[at(line, inn) + c] - src[at(line, out) + c];
      }
    }
  }
}
