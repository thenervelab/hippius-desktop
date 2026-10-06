/**
 * The screenshot editor's document: what has been drawn on the picture and
 * how it is cropped, plus undo / redo. Pure, so every operation is tested
 * without a canvas. All coordinates are the ORIGINAL picture's pixels; the
 * view maps them to the screen (`view.ts`) and the crop only decides which
 * part is exported.
 *
 * This is presentation state for the pixels being edited. Where the result
 * goes (the file, its upload, its link) is Rust's (`capture/editor.rs`).
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ToolId =
  | "select"
  | "crop"
  | "arrow"
  | "line"
  | "rect"
  | "ellipse"
  | "text"
  | "highlight"
  | "step"
  | "blur"
  | "pixelate";

interface Base {
  id: string;
}

export type LineAnnotation = Base & { kind: "arrow" | "line"; from: Point; to: Point; color: string; width: number };
export type ShapeAnnotation = Base & { kind: "rect" | "ellipse"; rect: Rect; color: string; width: number };
export type HighlightAnnotation = Base & { kind: "highlight"; points: Point[]; color: string; width: number };
export type TextAnnotation = Base & { kind: "text"; at: Point; text: string; color: string; size: number };
export type StepAnnotation = Base & { kind: "step"; at: Point; n: number; color: string; size: number };
/** Blur and pixelate change the picture's own pixels when exported. */
export type RedactAnnotation = Base & { kind: "blur" | "pixelate"; rect: Rect };

export type Annotation =
  | LineAnnotation
  | ShapeAnnotation
  | HighlightAnnotation
  | TextAnnotation
  | StepAnnotation
  | RedactAnnotation;

export interface Doc {
  /** Bottom first: the last one is drawn on top and hit first. */
  annotations: Annotation[];
  /** The part of the picture that is kept; `null` = all of it. */
  crop: Rect | null;
}

export const EMPTY_DOC: Doc = { annotations: [], crop: null };

export function isRedaction(a: Annotation): a is RedactAnnotation {
  return a.kind === "blur" || a.kind === "pixelate";
}

// ── Undo / redo ─────────────────────────────────────────────────────────────

/** How many steps Undo can go back. */
export const HISTORY_LIMIT = 100;

export interface History {
  past: Doc[];
  present: Doc;
  future: Doc[];
}

export function startHistory(doc: Doc = EMPTY_DOC): History {
  return { past: [], present: doc, future: [] };
}

/** A new state the user made: one undo step. Redo is cleared. */
export function commit(h: History, next: Doc): History {
  if (next === h.present) return h;
  const past = [...h.past, h.present];
  return { past: past.slice(Math.max(0, past.length - HISTORY_LIMIT)), present: next, future: [] };
}

export function undo(h: History): History {
  const prev = h.past[h.past.length - 1];
  if (!prev) return h;
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo(h: History): History {
  const [next, ...rest] = h.future;
  if (!next) return h;
  return { past: [...h.past, h.present], present: next, future: rest };
}

/** Whether there is anything to save: the picture differs from how it opened. */
export function isDirty(h: History): boolean {
  const doc = h.present;
  return doc.annotations.length > 0 || doc.crop !== null;
}

// ── Annotations ─────────────────────────────────────────────────────────────

let seq = 0;
/** A fresh id; unique within the page. */
export function newId(): string {
  seq += 1;
  return `a${Date.now().toString(36)}${seq}`;
}

export function addAnnotation(doc: Doc, a: Annotation): Doc {
  return { ...doc, annotations: [...doc.annotations, a] };
}

export function updateAnnotation(doc: Doc, id: string, change: (a: Annotation) => Annotation): Doc {
  let changed = false;
  const annotations = doc.annotations.map((a) => {
    if (a.id !== id) return a;
    const next = change(a);
    if (next !== a) changed = true;
    return next;
  });
  return changed ? { ...doc, annotations } : doc;
}

export function removeAnnotation(doc: Doc, id: string): Doc {
  const annotations = doc.annotations.filter((a) => a.id !== id);
  return annotations.length === doc.annotations.length ? doc : { ...doc, annotations };
}

export function findAnnotation(doc: Doc, id: string | null): Annotation | null {
  return id === null ? null : (doc.annotations.find((a) => a.id === id) ?? null);
}

/** The next step marker's number: one past the highest on the picture. */
export function nextStepNumber(doc: Doc): number {
  return doc.annotations.reduce((n, a) => (a.kind === "step" ? Math.max(n, a.n) : n), 0) + 1;
}

/** A rectangle with a positive size from two corners in any order. */
export function rectFrom(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

const translate = (p: Point, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy });

export function moveAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  switch (a.kind) {
    case "arrow":
    case "line":
      return { ...a, from: translate(a.from, dx, dy), to: translate(a.to, dx, dy) };
    case "rect":
    case "ellipse":
    case "blur":
    case "pixelate":
      return { ...a, rect: { ...a.rect, x: a.rect.x + dx, y: a.rect.y + dy } };
    case "highlight":
      return { ...a, points: a.points.map((p) => translate(p, dx, dy)) };
    case "text":
    case "step":
      return { ...a, at: translate(a.at, dx, dy) };
  }
}

/** Approximate box of a text annotation (the canvas measures it exactly when drawing). */
export function textBox(a: TextAnnotation): Rect {
  const lines = (a.text || " ").split("\n");
  const longest = Math.max(...lines.map((l) => l.length), 1);
  return { x: a.at.x, y: a.at.y, w: longest * a.size * 0.6, h: lines.length * a.size * TEXT_LINE_HEIGHT };
}

export const TEXT_LINE_HEIGHT = 1.25;

export function stepRadius(a: StepAnnotation): number {
  return a.size * 0.75;
}

/** The box an annotation covers. */
export function bounds(a: Annotation): Rect {
  switch (a.kind) {
    case "arrow":
    case "line":
      return rectFrom(a.from, a.to);
    case "rect":
    case "ellipse":
    case "blur":
    case "pixelate":
      return a.rect;
    case "highlight": {
      const xs = a.points.map((p) => p.x);
      const ys = a.points.map((p) => p.y);
      const r = { x: Math.min(...xs), y: Math.min(...ys), w: 0, h: 0 };
      return { ...r, w: Math.max(...xs) - r.x, h: Math.max(...ys) - r.y };
    }
    case "text":
      return textBox(a);
    case "step": {
      const r = stepRadius(a);
      return { x: a.at.x - r, y: a.at.y - r, w: r * 2, h: r * 2 };
    }
  }
}

/** Too small to have been meant: a click with a drawing tool, not a drag. */
export function isTrivial(a: Annotation, minSize = 3): boolean {
  switch (a.kind) {
    case "arrow":
    case "line":
      return Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y) < minSize;
    case "rect":
    case "ellipse":
    case "blur":
    case "pixelate":
      return a.rect.w < minSize || a.rect.h < minSize;
    case "highlight": {
      const b = bounds(a);
      return a.points.length < 2 || Math.max(b.w, b.h) < minSize;
    }
    case "text":
      return a.text.trim() === "";
    case "step":
      return false;
  }
}

// ── Hit testing ─────────────────────────────────────────────────────────────

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function inRect(p: Point, r: Rect, pad = 0): boolean {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}

/** Whether `p` touches `a`, within `tolerance` picture pixels. */
export function hits(a: Annotation, p: Point, tolerance: number): boolean {
  switch (a.kind) {
    case "arrow":
    case "line":
      return distanceToSegment(p, a.from, a.to) <= tolerance + a.width / 2;
    case "rect": {
      // Only the outline: the inside of a rectangle is the picture.
      const { x, y, w, h } = a.rect;
      const corners: Point[] = [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
      const pad = tolerance + a.width / 2;
      return corners.some((c, i) => distanceToSegment(p, c, corners[(i + 1) % 4]) <= pad);
    }
    case "ellipse": {
      const rx = a.rect.w / 2;
      const ry = a.rect.h / 2;
      if (rx === 0 || ry === 0) return false;
      const cx = a.rect.x + rx;
      const cy = a.rect.y + ry;
      // Normalised radius: 1 on the outline. The band is the stroke plus tolerance.
      const d = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
      const band = (tolerance + a.width / 2) / Math.min(rx, ry);
      return Math.abs(d - 1) <= band;
    }
    case "highlight":
      return a.points.some((pt, i) => i > 0 && distanceToSegment(p, a.points[i - 1], pt) <= tolerance + a.width / 2);
    case "blur":
    case "pixelate":
    case "text":
      return inRect(p, bounds(a), tolerance);
    case "step":
      return Math.hypot(p.x - a.at.x, p.y - a.at.y) <= stepRadius(a) + tolerance;
  }
}

/** The topmost annotation under `p`, or null. */
export function hitTest(doc: Doc, p: Point, tolerance: number): string | null {
  for (let i = doc.annotations.length - 1; i >= 0; i--) {
    const a = doc.annotations[i];
    if (hits(a, p, tolerance)) return a.id;
  }
  return null;
}

// ── Resize handles ──────────────────────────────────────────────────────────

export type Handle = "start" | "end" | "nw" | "ne" | "sw" | "se";

/** Where an annotation's handles are; text, steps and highlights only move. */
export function handlesFor(a: Annotation): { handle: Handle; at: Point }[] {
  switch (a.kind) {
    case "arrow":
    case "line":
      return [
        { handle: "start", at: a.from },
        { handle: "end", at: a.to },
      ];
    case "rect":
    case "ellipse":
    case "blur":
    case "pixelate":
      return rectHandles(a.rect);
    default:
      return [];
  }
}

export function rectHandles(r: Rect): { handle: Handle; at: Point }[] {
  return [
    { handle: "nw", at: { x: r.x, y: r.y } },
    { handle: "ne", at: { x: r.x + r.w, y: r.y } },
    { handle: "sw", at: { x: r.x, y: r.y + r.h } },
    { handle: "se", at: { x: r.x + r.w, y: r.y + r.h } },
  ];
}

export function hitHandle(a: Annotation, p: Point, tolerance: number): Handle | null {
  return handlesFor(a).find((h) => Math.hypot(p.x - h.at.x, p.y - h.at.y) <= tolerance)?.handle ?? null;
}

/** `r` with the corner `handle` dragged to `p`; the opposite corner stays. */
export function resizeRect(r: Rect, handle: Handle, p: Point): Rect {
  const opposite: Record<string, Point> = {
    nw: { x: r.x + r.w, y: r.y + r.h },
    ne: { x: r.x, y: r.y + r.h },
    sw: { x: r.x + r.w, y: r.y },
    se: { x: r.x, y: r.y },
  };
  const anchor = opposite[handle];
  return anchor ? rectFrom(anchor, p) : r;
}

export function resizeAnnotation(a: Annotation, handle: Handle, p: Point): Annotation {
  switch (a.kind) {
    case "arrow":
    case "line":
      if (handle === "start") return { ...a, from: p };
      if (handle === "end") return { ...a, to: p };
      return a;
    case "rect":
    case "ellipse":
    case "blur":
    case "pixelate":
      return { ...a, rect: resizeRect(a.rect, handle, p) };
    default:
      return a;
  }
}

/** Colour and size apply to whatever carries them. */
export function restyle(a: Annotation, style: { color?: string; width?: number; textSize?: number }): Annotation {
  switch (a.kind) {
    case "arrow":
    case "line":
    case "rect":
    case "ellipse":
    case "highlight":
      return {
        ...a,
        color: style.color ?? a.color,
        width: style.width ?? a.width,
      };
    case "text":
    case "step":
      return { ...a, color: style.color ?? a.color, size: style.textSize ?? a.size };
    default:
      return a;
  }
}
