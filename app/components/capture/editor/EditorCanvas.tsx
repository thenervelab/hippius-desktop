"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Annotation, type Doc, type Point, bounds as boxOf, findAnnotation, handlesFor, isRedaction, rectHandles } from "@/app/lib/capture/editor/model";
import { type Bounds, type Gesture, type Style, cursorAt, drag, press, release } from "@/app/lib/capture/editor/gesture";
import { drawAnnotation, fontFor, redactRegions } from "@/app/lib/capture/editor/render";
import { type View, fitView, pannedCenter, toImage, toScreen, zoomOf, zoomedView } from "@/app/lib/capture/editor/view";
import type { ToolId } from "@/app/lib/capture/editor/model";

/** Space around the picture inside the canvas area, in points. */
const PADDING = 24;
/** How near the pointer must be to grab something, in screen points. */
const GRAB_PT = 8;
const HANDLE_PT = 5;

export interface TextEdit {
  id: string | null;
  at: Point;
  text: string;
  color: string;
  size: number;
}

interface Props {
  image: CanvasImageSource;
  imageW: number;
  imageH: number;
  doc: Doc;
  selected: string | null;
  tool: ToolId;
  style: Style;
  ratio: number | null;
  block: number;
  textEdit: TextEdit | null;
  /** Picture pixels per screen pixel; null fits the picture in the box. */
  zoom: number | null;
  /** The picture point in the middle of the box while zoomed; null centres it. */
  center: Point | null;
  /** The zoom on screen now (fitted or chosen), for the zoom pill. */
  onScale: (zoom: number) => void;
  /** The view moved (a scroll while zoomed): the new middle of the box. */
  onPan: (center: Point) => void;
  /** A pinch or Ctrl/Cmd + wheel: one zoom step in (1) or out (-1). */
  onZoomStep: (direction: 1 | -1) => void;
  /** Shown next to the selected annotation (its colour, thickness, delete). */
  selectionBar: React.ReactNode;
  /** The document to show mid-drag; null when the drag is over. */
  onPreview: (doc: Doc | null) => void;
  /** A finished change: one undo step. */
  onCommit: (doc: Doc, selected: string | null) => void;
  onSelect: (id: string | null) => void;
  onStartText: (edit: { id: string | null; at: Point }) => void;
  onTextChange: (text: string) => void;
  onTextDone: (cancelled: boolean) => void;
}

/**
 * The picture and what is drawn on it, on one canvas sized to its box at the
 * screen's pixel density. Pointer events become picture points for the pure
 * gesture functions; blur and pixelate are shown exactly as they will be
 * exported, by running the same pixel code over a copy of the picture.
 */
export default function EditorCanvas(props: Props) {
  const { image, imageW, imageH, doc, selected, tool, style, ratio, block, textEdit, zoom, center, onScale, onPan, onZoomStep } = props;
  const box = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Where the pointer rests over the picture (picture pixels), so the cursor
  // can say what a press there will do; null while it is elsewhere. Only
  // stored when the cursor it gives changes, so plain hovering does not
  // re-render the editor on every move.
  const [hover, setHover] = useState<Point | null>(null);
  const hoverCursor = useRef<string | null>(null);
  // The cursor a drag started with, kept until release: mid-move the shape
  // slides out from under the pointer's first position.
  const [heldCursor, setHeldCursor] = useState<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const live = useRef<Doc>(doc);
  live.current = doc;
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The whole picture while cropping (to see what is left out), else the crop.
  const region = useMemo(
    () => (tool === "crop" || !doc.crop ? { x: 0, y: 0, w: imageW, h: imageH } : doc.crop),
    [tool, doc.crop, imageW, imageH],
  );
  const view: View = useMemo(
    () => (zoom === null ? fitView(region, size.w, size.h, PADDING, dpr) : zoomedView(region, size.w, size.h, zoom, dpr, center)),
    [region, size.w, size.h, dpr, zoom, center],
  );
  const shownZoom = zoomOf(view, dpr);
  useEffect(() => {
    if (size.w > 0) onScale(shownZoom);
  }, [shownZoom, size.w, onScale]);

  // The wheel: a pinch (or Ctrl/Cmd + wheel) zooms; a plain scroll moves a
  // zoomed picture. Not passive, so the page behind never scrolls instead.
  const wheel = useRef({ view, zoomed: zoom !== null, size, onPan, onZoomStep });
  wheel.current = { view, zoomed: zoom !== null, size, onPan, onZoomStep };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const w = wheel.current;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        if (Math.abs(e.deltaY) >= 1) w.onZoomStep(e.deltaY < 0 ? 1 : -1);
        return;
      }
      if (w.zoomed) w.onPan(pannedCenter(w.view, w.size.w, w.size.h, e.deltaX, e.deltaY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // The picture with its redactions, rebuilt only when a redaction changes,
  // and then only inside each redaction's own box (`redactRegions`).
  const redactionKey = JSON.stringify(doc.annotations.filter(isRedaction));
  const base = useMemo(() => {
    if (typeof document === "undefined") return null;
    const c = document.createElement("canvas");
    c.width = imageW;
    c.height = imageH;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0);
    redactRegions(ctx, JSON.parse(redactionKey) as Doc["annotations"], imageW, imageH, block);
    return c;
  }, [image, imageW, imageH, redactionKey, block]);

  // The backdrop: the picture's shadow and the picture itself, drawn at the
  // canvas's size. The shadow is a large blur and the picture a full-size
  // scale-down, far too slow to repeat on every pointer move, so they are
  // drawn here once per view or redaction change and copied in each frame.
  const backdrop = useMemo(() => {
    if (typeof document === "undefined" || size.w === 0) return null;
    const c = document.createElement("canvas");
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    const s = view.scale * dpr;
    ctx.setTransform(s, 0, 0, s, (view.offsetX - view.region.x * view.scale) * dpr, (view.offsetY - view.region.y * view.scale) * dpr);
    // A soft shadow under the picture, so it lifts off the dark backdrop.
    // Only the shadow is painted: the fill itself is clipped away, so a
    // picture with transparent corners (a window shot) shows the backdrop.
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.region.x - imageW, view.region.y - imageH, view.region.w + imageW * 2, view.region.h + imageH * 2);
    ctx.rect(view.region.x, view.region.y, view.region.w, view.region.h);
    ctx.clip("evenodd");
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 28 * dpr;
    ctx.shadowOffsetY = 6 * dpr;
    ctx.fillStyle = "#000000";
    ctx.fillRect(view.region.x, view.region.y, view.region.w, view.region.h);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.region.x, view.region.y, view.region.w, view.region.h);
    ctx.clip();
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(base ?? image, 0, 0);
    ctx.restore();
    return c;
  }, [base, image, view, size.w, size.h, dpr, imageW, imageH]);

  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || size.w === 0) return;
    // Setting a canvas's size clears and reallocates it: only on a resize.
    const w = Math.round(size.w * dpr);
    const h = Math.round(size.h * dpr);
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (backdrop) ctx.drawImage(backdrop, 0, 0);
    const s = view.scale * dpr;
    ctx.setTransform(s, 0, 0, s, (view.offsetX - view.region.x * view.scale) * dpr, (view.offsetY - view.region.y * view.scale) * dpr);
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.region.x, view.region.y, view.region.w, view.region.h);
    ctx.clip();
    for (const a of doc.annotations) {
      // The text being typed is drawn by the field over it, not twice.
      if (textEdit?.id && a.id === textEdit.id) continue;
      drawAnnotation(ctx, a);
    }
    ctx.restore();
    const px = 1 / view.scale;
    if (tool === "crop" && doc.crop) {
      const r = doc.crop;
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.beginPath();
      ctx.rect(0, 0, imageW, imageH);
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.fill("evenodd");
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = 1.5 * px;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      // Thirds, as every crop tool shows.
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = px;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(r.x + (r.w * i) / 3, r.y);
        ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
        ctx.moveTo(r.x, r.y + (r.h * i) / 3);
        ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
        ctx.stroke();
      }
      ctx.restore();
      drawHandles(ctx, rectHandles(r).map((h) => h.at), px);
    }
    const current = tool === "crop" ? null : findAnnotation(doc, selected);
    if (current && !textEdit) {
      const handles = handlesFor(current);
      if (handles.length > 0) drawHandles(ctx, handles.map((h) => h.at), px);
      else outline(ctx, current, px);
    }
  }, [backdrop, doc, selected, tool, view, size, dpr, imageW, imageH, textEdit]);

  const bounds: Bounds = { imageW, imageH, tolerance: GRAB_PT / view.scale, ratio };
  const at = (e: React.PointerEvent) => {
    const rect = canvas.current?.getBoundingClientRect();
    return toImage(view, { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || textEdit) return;
    const p = at(e);
    const pressed = press(tool, live.current, selected, p, style, bounds);
    if (pressed.text) {
      // Keep the press from moving focus: the text field it opens takes it,
      // and a focus change after would blur (and end) the field at once.
      e.preventDefault();
      props.onStartText(pressed.text);
      return;
    }
    if (pressed.commit) {
      props.onCommit(pressed.doc, pressed.selected);
      return;
    }
    props.onSelect(pressed.selected);
    if (!pressed.gesture) return;
    gesture.current = pressed.gesture;
    setHeldCursor(cursorAt(tool, live.current, selected, p, bounds.tolerance));
    props.onPreview(pressed.doc);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  // A drag moves the document at most once per screen frame: pointer events
  // can arrive faster than the screen redraws, and each preview re-renders
  // the editor. Only the newest point counts.
  const pending = useRef<Point | null>(null);
  const frame = useRef<number | null>(null);
  const onDrag = useRef<() => void>(() => {});
  onDrag.current = () => {
    const g = gesture.current;
    const p = pending.current;
    pending.current = null;
    if (g && p) props.onPreview(drag(g, live.current, p, bounds));
  };
  const cancelFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    pending.current = null;
  };
  useEffect(() => cancelFrame, []);

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = at(e);
    if (!gesture.current) {
      const next = cursorAt(tool, live.current, selected, p, bounds.tolerance);
      if (next !== hoverCursor.current) {
        hoverCursor.current = next;
        setHover(p);
      }
      return;
    }
    pending.current = p;
    if (frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        onDrag.current();
      });
    }
  };

  const finish = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (!g) return;
    cancelFrame();
    gesture.current = null;
    setHeldCursor(null);
    const done = release(g, drag(g, live.current, at(e), bounds));
    props.onPreview(null);
    // The drawn, moved or resized annotation stays selected, so a colour
    // picked next applies to it.
    if (done) props.onCommit(done, "id" in g ? g.id : tool === "crop" ? null : selected);
  };

  // Focus the field once it is on screen, after the press that opened it.
  const textField = useRef<HTMLTextAreaElement | null>(null);
  const editing = textEdit !== null;
  useLayoutEffect(() => {
    if (editing) textField.current?.focus();
  }, [editing]);

  const editAt = textEdit ? toScreen(view, textEdit.at) : null;
  // The selection bar sits above the annotation, or below it near the top.
  const picked = tool === "crop" || textEdit ? null : findAnnotation(doc, selected);
  const barAt = picked && props.selectionBar ? selectionAnchor(view, boxOf(picked), size.w) : null;
  // Held while dragging, so the cursor does not flicker back mid-move.
  const cursor = textEdit ? "text" : (heldCursor ?? cursorAt(tool, doc, selected, hover, bounds.tolerance));

  return (
    <div ref={box} className="relative h-full w-full overflow-hidden" data-testid="editor-canvas-box">
      <canvas
        ref={canvas}
        aria-label="Screenshot being edited"
        role="img"
        style={{ width: size.w, height: size.h, cursor, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onPointerLeave={() => {
          hoverCursor.current = null;
          setHover(null);
        }}
      />
      {textEdit && editAt && (
        <textarea
          ref={textField}
          aria-label="Text"
          value={textEdit.text}
          onChange={(e) => props.onTextChange(e.target.value)}
          onBlur={() => props.onTextDone(false)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              props.onTextDone(true);
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              props.onTextDone(false);
            }
          }}
          rows={Math.max(1, textEdit.text.split("\n").length)}
          className="absolute resize-none overflow-hidden whitespace-pre border border-dashed border-[#3167DD] bg-transparent p-0 leading-[1.25] outline-none"
          style={{
            left: editAt.x,
            top: editAt.y,
            color: textEdit.color,
            font: fontFor(textEdit.size * view.scale),
            minWidth: 40,
            width: `${Math.max(4, ...textEdit.text.split("\n").map((l) => l.length + 2))}ch`,
          }}
        />
      )}
      {barAt && (
        <div
          className="absolute z-10"
          style={{ left: barAt.x, top: barAt.y, transform: barAt.above ? "translate(-50%, -100%)" : "translate(-50%, 0)" }}
          data-testid="selection-bar-anchor"
        >
          {props.selectionBar}
        </div>
      )}
    </div>
  );
}

/** Room the selection bar needs above an annotation, in points. */
const BAR_ROOM = 52;
/** How near the box's sides the bar's middle may come, in points. */
const BAR_HALF = 120;

/**
 * Where the selection bar goes for an annotation's picture `r`: centred
 * over it, 10 points above, or below it when there is no room above; kept
 * inside the box sideways.
 */
export function selectionAnchor(view: View, r: { x: number; y: number; w: number; h: number }, boxW: number): { x: number; y: number; above: boolean } {
  const topLeft = toScreen(view, { x: r.x, y: r.y });
  const bottomRight = toScreen(view, { x: r.x + r.w, y: r.y + r.h });
  const mid = (topLeft.x + bottomRight.x) / 2;
  const x = boxW > BAR_HALF * 2 ? Math.max(BAR_HALF, Math.min(boxW - BAR_HALF, mid)) : boxW / 2;
  const above = topLeft.y - 10 >= BAR_ROOM;
  return { x, y: above ? topLeft.y - 10 : bottomRight.y + 10, above };
}

function drawHandles(ctx: CanvasRenderingContext2D, points: Point[], px: number) {
  ctx.save();
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_PT * px, 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = "#3167DD";
    ctx.stroke();
  }
  ctx.restore();
}

function outline(ctx: CanvasRenderingContext2D, a: Annotation, px: number) {
  const r = boxOf(a);
  ctx.save();
  ctx.setLineDash([4 * px, 3 * px]);
  ctx.lineWidth = 1.5 * px;
  ctx.strokeStyle = "#3167DD";
  ctx.strokeRect(r.x - 4 * px, r.y - 4 * px, r.w + 8 * px, r.h + 8 * px);
  ctx.restore();
}
