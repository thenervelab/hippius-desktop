import {
  type Annotation,
  type Doc,
  type Handle,
  type Point,
  type Rect,
  addAnnotation,
  findAnnotation,
  hitHandle,
  hitTest,
  isTrivial,
  moveAnnotation,
  newId,
  nextStepNumber,
  rectFrom,
  rectHandles,
  resizeAnnotation,
  resizeRect,
  updateAnnotation,
  type ToolId,
} from "./model";
import { clampCrop, cropFromDrag, moveCrop } from "./view";

/**
 * What a press, drag and release on the picture does with each tool, as
 * pure functions: the canvas only turns pointer events into picture points
 * and draws whatever document these return. One drag is one undo step.
 */

export interface Style {
  color: string;
  /** Stroke width in picture pixels. */
  stroke: number;
  /** Text size in picture pixels. */
  textSize: number;
}

export interface Bounds {
  imageW: number;
  imageH: number;
  /** How near a press must be to hit something, in picture pixels. */
  tolerance: number;
  /** The crop's shape when one is chosen; null = freeform. */
  ratio: number | null;
}

export type Gesture =
  | { type: "draw"; base: Doc; id: string; start: Point }
  | { type: "move"; base: Doc; id: string; start: Point }
  | { type: "resize"; base: Doc; id: string; handle: Handle }
  | { type: "crop-new"; base: Doc; start: Point }
  | { type: "crop-move"; base: Doc; start: Point; crop: Rect }
  | { type: "crop-resize"; base: Doc; handle: Handle; crop: Rect };

export interface Pressed {
  gesture: Gesture | null;
  /** The document to show from now on (a new step is already in it). */
  doc: Doc;
  selected: string | null;
  /** The press made a finished change by itself (a step marker): commit `doc`. */
  commit: boolean;
  /** Start typing: a new text at `at`, or the existing text `id`. */
  text?: { id: string | null; at: Point };
}

function shapeFor(tool: ToolId, id: string, p: Point, style: Style): Annotation | null {
  switch (tool) {
    case "arrow":
    case "line":
      return { id, kind: tool, from: p, to: p, color: style.color, width: style.stroke };
    case "rect":
    case "ellipse":
      return { id, kind: tool, rect: { x: p.x, y: p.y, w: 0, h: 0 }, color: style.color, width: style.stroke };
    case "highlight":
      // A marker is wide: about a line of text.
      return { id, kind: "highlight", points: [p], color: style.color, width: style.stroke * 4 };
    case "blur":
    case "pixelate":
      return { id, kind: tool, rect: { x: p.x, y: p.y, w: 0, h: 0 } };
    default:
      return null;
  }
}

/** The pointer went down at `p`. */
export function press(tool: ToolId, doc: Doc, selected: string | null, p: Point, style: Style, b: Bounds): Pressed {
  const nothing: Pressed = { gesture: null, doc, selected, commit: false };
  switch (tool) {
    case "select": {
      const current = findAnnotation(doc, selected);
      const handle = current ? hitHandle(current, p, b.tolerance) : null;
      if (current && handle) return { ...nothing, gesture: { type: "resize", base: doc, id: current.id, handle } };
      const id = hitTest(doc, p, b.tolerance);
      if (!id) return { ...nothing, selected: null };
      return { ...nothing, selected: id, gesture: { type: "move", base: doc, id, start: p } };
    }
    case "crop": {
      const crop = doc.crop;
      if (crop) {
        const handle = rectHandles(crop).find((h) => Math.hypot(p.x - h.at.x, p.y - h.at.y) <= b.tolerance * 1.5)?.handle;
        if (handle) return { ...nothing, gesture: { type: "crop-resize", base: doc, handle, crop } };
        const inside = p.x >= crop.x && p.x <= crop.x + crop.w && p.y >= crop.y && p.y <= crop.y + crop.h;
        if (inside) return { ...nothing, gesture: { type: "crop-move", base: doc, start: p, crop } };
      }
      return { ...nothing, gesture: { type: "crop-new", base: doc, start: p } };
    }
    case "text": {
      const id = hitTest(doc, p, b.tolerance);
      const hit = findAnnotation(doc, id);
      if (hit && hit.kind === "text") return { ...nothing, selected: hit.id, text: { id: hit.id, at: hit.at } };
      return { ...nothing, selected: null, text: { id: null, at: p } };
    }
    case "step": {
      const id = newId();
      const next = addAnnotation(doc, { id, kind: "step", at: p, n: nextStepNumber(doc), color: style.color, size: style.textSize });
      return { gesture: null, doc: next, selected: id, commit: true };
    }
    default: {
      const id = newId();
      const shape = shapeFor(tool, id, p, style);
      if (!shape) return nothing;
      return { gesture: { type: "draw", base: doc, id, start: p }, doc: addAnnotation(doc, shape), selected: id, commit: false };
    }
  }
}

/** The pointer moved to `p` mid-drag: the document to show now. */
export function drag(g: Gesture, current: Doc, p: Point, b: Bounds): Doc {
  switch (g.type) {
    case "draw":
      return updateAnnotation(current, g.id, (a) => {
        switch (a.kind) {
          case "arrow":
          case "line":
            return { ...a, to: p };
          case "rect":
          case "ellipse":
          case "blur":
          case "pixelate":
            return { ...a, rect: rectFrom(g.start, p) };
          case "highlight":
            return { ...a, points: [...a.points, p] };
          default:
            return a;
        }
      });
    case "move":
      return updateAnnotation(g.base, g.id, (a) => moveAnnotation(a, p.x - g.start.x, p.y - g.start.y));
    case "resize":
      return updateAnnotation(g.base, g.id, (a) => resizeAnnotation(a, g.handle, p));
    case "crop-new":
      return { ...g.base, crop: cropFromDrag(g.start, p, b.ratio, b.imageW, b.imageH) ?? g.base.crop };
    case "crop-move":
      return { ...g.base, crop: moveCrop(g.crop, p.x - g.start.x, p.y - g.start.y, b.imageW, b.imageH) };
    case "crop-resize": {
      const r = resizeRect(g.crop, g.handle, p);
      return r.w >= 4 && r.h >= 4 ? { ...g.base, crop: clampCrop(r, b.imageW, b.imageH) } : g.base;
    }
  }
}

/**
 * The pointer came up: the document to commit, or null when the drag
 * changed nothing worth an undo step (a click with a drawing tool, or a
 * press on an annotation that did not move it).
 */
export function release(g: Gesture, current: Doc): Doc | null {
  if (g.type === "draw") {
    const made = findAnnotation(current, g.id);
    return made && !isTrivial(made) ? current : null;
  }
  return current === g.base || sameDoc(current, g.base) ? null : current;
}

function sameDoc(a: Doc, b: Doc): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Text typed for `id` (or a new text at `at`): the document to commit, or null for nothing. */
export function finishText(doc: Doc, edit: { id: string | null; at: Point }, text: string, style: Style): Doc | null {
  const trimmed = text.replace(/\s+$/, "");
  if (edit.id) {
    const existing = findAnnotation(doc, edit.id);
    if (!existing || existing.kind !== "text") return null;
    if (trimmed === "") return { ...doc, annotations: doc.annotations.filter((a) => a.id !== edit.id) };
    return trimmed === existing.text ? null : updateAnnotation(doc, edit.id, (a) => ({ ...a, text: trimmed }) as Annotation);
  }
  if (trimmed.trim() === "") return null;
  return addAnnotation(doc, { id: newId(), kind: "text", at: edit.at, text: trimmed, color: style.color, size: style.textSize });
}
