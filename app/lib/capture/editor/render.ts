import {
  type Annotation,
  type Doc,
  type Point,
  type Rect,
  TEXT_LINE_HEIGHT,
  isRedaction,
  stepRadius,
} from "./model";
import { blur, pixelBox, pixelate, type Pixels } from "./pixels";

/**
 * Drawing the document, the same code on screen and in the exported PNG, so
 * what is saved is what was seen. Every function takes a context already
 * transformed to picture pixels.
 */

/** The three points of an arrow's head at `to`, sized by the stroke. */
export function arrowHead(from: Point, to: Point, width: number): [Point, Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.max(10, width * 4.5);
  const spread = Math.PI / 7;
  return [
    to,
    { x: to.x - length * Math.cos(angle - spread), y: to.y - length * Math.sin(angle - spread) },
    { x: to.x - length * Math.cos(angle + spread), y: to.y - length * Math.sin(angle + spread) },
  ];
}

/** Black or white, whichever reads on `color` (a `#rrggbb`). */
export function contrastOn(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return "#FFFFFF";
  const n = parseInt(m[1], 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 150 ? "#000000" : "#FFFFFF";
}

export const TEXT_FONT = '600 {size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export function fontFor(size: number): string {
  return TEXT_FONT.replace("{size}", String(Math.round(size)));
}

/** Draw one vector annotation (redactions are pixels, see `applyRedactions`). */
export function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (a.kind) {
    case "line":
    case "arrow": {
      ctx.strokeStyle = a.color;
      ctx.fillStyle = a.color;
      ctx.lineWidth = a.width;
      const head = a.kind === "arrow" ? arrowHead(a.from, a.to, a.width) : null;
      // The shaft stops inside the head so its round cap never shows at the tip.
      const end = head ? { x: (head[1].x + head[2].x) / 2, y: (head[1].y + head[2].y) / 2 } : a.to;
      ctx.beginPath();
      ctx.moveTo(a.from.x, a.from.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      if (head) {
        ctx.beginPath();
        ctx.moveTo(head[0].x, head[0].y);
        ctx.lineTo(head[1].x, head[1].y);
        ctx.lineTo(head[2].x, head[2].y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      break;
    }
    case "rect":
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.strokeRect(a.rect.x, a.rect.y, a.rect.w, a.rect.h);
      break;
    case "ellipse":
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.beginPath();
      ctx.ellipse(a.rect.x + a.rect.w / 2, a.rect.y + a.rect.h / 2, a.rect.w / 2, a.rect.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "highlight":
      // A marker: translucent, and multiplied so the text under it stays dark.
      ctx.globalAlpha = 0.4;
      ctx.globalCompositeOperation = "multiply";
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.lineCap = "square";
      ctx.beginPath();
      a.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      break;
    case "text": {
      ctx.font = fontFor(a.size);
      ctx.textBaseline = "top";
      ctx.lineWidth = Math.max(2, a.size / 7);
      ctx.strokeStyle = contrastOn(a.color);
      ctx.fillStyle = a.color;
      a.text.split("\n").forEach((line, i) => {
        const y = a.at.y + i * a.size * TEXT_LINE_HEIGHT;
        ctx.strokeText(line, a.at.x, y);
        ctx.fillText(line, a.at.x, y);
      });
      break;
    }
    case "step": {
      const r = stepRadius(a);
      ctx.fillStyle = a.color;
      ctx.beginPath();
      ctx.arc(a.at.x, a.at.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r / 8);
      ctx.strokeStyle = contrastOn(a.color) === "#000000" ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.9)";
      ctx.stroke();
      ctx.fillStyle = contrastOn(a.color);
      ctx.font = fontFor(r * 1.1);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(a.n), a.at.x, a.at.y + r * 0.05);
      break;
    }
    case "blur":
    case "pixelate":
      break;
  }
  ctx.restore();
}

/**
 * Scramble every blur and pixelate region of `doc` in `px`, in drawing
 * order. `origin` is where `px`'s top-left pixel is in the picture (the
 * crop's corner when exporting a cropped picture).
 */
export function applyRedactions(px: Pixels, doc: Doc, origin: Point, block: number): void {
  for (const a of doc.annotations) {
    if (!isRedaction(a)) continue;
    const r: Rect = { x: a.rect.x - origin.x, y: a.rect.y - origin.y, w: a.rect.w, h: a.rect.h };
    if (a.kind === "pixelate") pixelate(px, r, block);
    else blur(px, r, block);
  }
}

/** The two calls `redactRegions` makes on a 2D context. */
export interface PixelSurface {
  getImageData(x: number, y: number, w: number, h: number): ImageData;
  putImageData(data: ImageData, x: number, y: number): void;
}

/**
 * Write each redaction into `ctx` (a whole `width` x `height` picture),
 * reading and writing only that redaction's own box. Blur and pixelate read
 * and change only pixels inside their box, so the result is the same as
 * running `applyRedactions` over the whole picture, without copying every
 * pixel of a large screenshot each time a redaction moves. Applied in order,
 * so one that overlaps another blurs what the earlier one left.
 */
export function redactRegions(ctx: PixelSurface, annotations: readonly Annotation[], width: number, height: number, block: number): void {
  for (const a of annotations) {
    if (!isRedaction(a)) continue;
    const box = pixelBox(a.rect, width, height);
    if (!box) continue;
    const px = ctx.getImageData(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    applyRedactions(px, { annotations: [a], crop: null }, { x: box.x0, y: box.y0 }, block);
    ctx.putImageData(px, box.x0, box.y0);
  }
}

/** The part of the picture that is kept. */
export function exportRegion(doc: Doc, imageW: number, imageH: number): Rect {
  return doc.crop ?? { x: 0, y: 0, w: imageW, h: imageH };
}

/**
 * Flatten the picture and the document into one PNG: the kept region of the
 * picture, its redactions written into the pixels, then the drawings on top.
 *
 * # Errors
 *
 * Rejects when the browser cannot make a canvas or encode the PNG.
 */
export async function exportPng(
  image: CanvasImageSource,
  imageW: number,
  imageH: number,
  doc: Doc,
  block: number,
  makeCanvas: (w: number, h: number) => HTMLCanvasElement = defaultCanvas,
): Promise<Uint8Array> {
  const region = exportRegion(doc, imageW, imageH);
  const canvas = makeCanvas(region.w, region.h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This window can't draw the picture.");
  ctx.drawImage(image, -region.x, -region.y);
  if (doc.annotations.some(isRedaction)) {
    const px = ctx.getImageData(0, 0, region.w, region.h);
    applyRedactions(px, doc, { x: region.x, y: region.y }, block);
    ctx.putImageData(px, 0, 0);
  }
  ctx.save();
  ctx.translate(-region.x, -region.y);
  for (const a of doc.annotations) drawAnnotation(ctx, a);
  ctx.restore();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The picture couldn't be encoded.");
  return new Uint8Array(await blob.arrayBuffer());
}

function defaultCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}
