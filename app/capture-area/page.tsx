"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Video, X } from "lucide-react";
import "@/app/lib/capture/floating-window.css";
import {
  cancelCapture,
  chooseCaptureArea,
  getCaptureAreaContext,
  type CaptureAreaContext,
  type LogicalRect,
} from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { GLASS_BAR, GLASS_BUTTON, GLASS_PRIMARY, GLASS_MUTED } from "@/app/lib/capture/glass";
import { enterKeyName } from "@/app/lib/capture/shortcutLabel";
import {
  dragRect,
  HANDLES,
  handlePoint,
  hitTest,
  isRealDrag,
  moveRect,
  nudgeRect,
  resizeRect,
  sizeLabel,
  type Handle,
  type Point,
} from "@/app/capture-overlay/overlaySelection";

/**
 * Wayland's area selection (`capture-area`, opened by Rust's `draw_area`).
 *
 * Wayland lets no app draw over the screen or read it outside the
 * desktop's screen-sharing dialog, so the area is drawn on a PICTURE: the
 * first frame of the monitor the user chose in that dialog, shown full
 * screen. The page only draws and reports. It sends the rectangle in its
 * own CSS pixels together with where it showed the picture, and Rust maps
 * that onto the stream's own pixels (`area_pick::stream_area`), so the
 * monitor's scale (HiDPI, fractional) and where the compositor put this
 * window never matter here.
 *
 * Fixed palette, like the overlay it stands in for: it shows the user's
 * own screen, not Hippius, so the app's theme says nothing about it.
 */

const DIM = "rgba(0, 0, 0, 0.45)";

type Drag =
  | { op: "create"; start: Point; current: Point }
  | { op: "move"; last: Point }
  | { op: "resize"; handle: Handle };

const CURSOR: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

const bounds = () => ({ width: window.innerWidth, height: window.innerHeight });

/** Where the picture is on the page: the image element is sized to the picture, never letterboxed inside itself. */
function shownBox(img: HTMLImageElement | null): LogicalRect | null {
  if (!img) return null;
  const r = img.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
}

export default function CaptureAreaPage() {
  const [context, setContext] = useState<CaptureAreaContext | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [rect, setRect] = useState<LogicalRect | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const latest = useRef<{ rect: LogicalRect | null; sending: boolean }>({ rect: null, sending: false });
  latest.current = { rect, sending };

  useEffect(() => {
    // No area waiting (the recording ended while this window opened): Rust
    // takes the window down; nothing to draw meanwhile.
    void getCaptureAreaContext()
      .then(setContext)
      .catch(() => undefined);
  }, []);

  const record = useCallback(() => {
    const { rect: area, sending: busy } = latest.current;
    const shown = shownBox(imgRef.current);
    if (busy || !shown) return;
    if (!area || !isRealDrag(area)) {
      setNotice("Drag to select an area to record.");
      return;
    }
    setNotice(null);
    setSending(true);
    // Rust closes this window once the recording starts; a refusal (the
    // area missed the picture) leaves it up with Rust's line.
    chooseCaptureArea(area, shown).catch((error) => {
      setNotice(errorMessage(error));
      setSending(false);
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void cancelCapture();
        return;
      }
      // Return on a focused bar button is that button's.
      if (e.target instanceof Element && e.target.closest("button")) return;
      if (e.key === "Enter") {
        e.preventDefault();
        record();
        return;
      }
      const area = latest.current.rect;
      const next = area ? nudgeRect(area, e.key, e.shiftKey, bounds()) : null;
      if (next) {
        e.preventDefault();
        setRect(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [record]);

  const pointFrom = (e: React.PointerEvent): Point => ({ x: e.clientX, y: e.clientY });

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || sending || !loaded) return;
    const p = pointFrom(e);
    const hit = rect ? hitTest(rect, p) : null;
    if (hit === "move") setDrag({ op: "move", last: p });
    else if (hit) setDrag({ op: "resize", handle: hit });
    else setDrag({ op: "create", start: p, current: p });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = pointFrom(e);
    if (drag.op === "create") setDrag({ ...drag, current: p });
    else if (drag.op === "move" && rect) {
      setRect(moveRect(rect, p.x - drag.last.x, p.y - drag.last.y, bounds()));
      setDrag({ op: "move", last: p });
    } else if (drag.op === "resize" && rect) {
      setRect(resizeRect(rect, drag.handle, p, bounds()));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.button !== 0 || !drag) return;
    if (drag.op === "create") {
      const created = dragRect(drag.start, pointFrom(e));
      // A click without a drag keeps the area that was there.
      if (isRealDrag(created)) {
        setRect(created);
        setNotice(null);
      }
    }
    setDrag(null);
  };

  const live = drag?.op === "create" ? dragRect(drag.start, drag.current) : rect;
  const cursor =
    drag?.op === "resize" ? CURSOR[drag.handle] : drag?.op === "move" ? "grabbing" : sending ? "default" : "crosshair";
  const ready = Boolean(rect && isRealDrag(rect));
  const enterKey = enterKeyName();
  const hint = notice ?? (ready ? `Press Record or ${enterKey} to start` : "Drag to choose the area to record");

  return (
    <div
      className="fixed inset-0 select-none overflow-hidden bg-[#000]"
      style={{ cursor }}
      data-testid="capture-area"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => ready && record()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {!loaded && (
        // Until the picture is in: a skeleton the size of the screen.
        <div
          data-testid="capture-area-skeleton"
          aria-hidden
          className="absolute inset-0 animate-pulse bg-gradient-to-br from-[#2a2c33] to-[#1c1d21] motion-reduce:animate-none"
        />
      )}
      {context && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {/* Sized to the picture (never letterboxed inside the element), so
              its box is exactly where the picture is. */}
          <img
            ref={imgRef}
            src={context.picture}
            alt="Your screen, to draw the area to record on"
            draggable={false}
            onLoad={() => setLoaded(true)}
            className="block h-auto max-h-full w-auto max-w-full"
          />
        </div>
      )}

      {loaded && !live && <div className="pointer-events-none absolute inset-0" style={{ background: DIM }} />}

      {loaded && live && (
        <div
          data-testid="capture-area-selection"
          className="pointer-events-none absolute"
          style={{
            left: live.x,
            top: live.y,
            width: live.width,
            height: live.height,
            // Everything outside the area darkens; the area stays clear.
            boxShadow: `0 0 0 100vmax ${DIM}`,
            outline: "1px dashed rgba(255,255,255,0.95)",
          }}
        >
          {isRealDrag(live) && (
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-[#000]/60 px-2 py-0.5 text-xs font-medium tabular-nums text-white">
              {sizeLabel(live)}
            </span>
          )}
        </div>
      )}

      {loaded && rect && !drag &&
        HANDLES.map((h) => {
          const p = handlePoint(rect, h);
          return (
            <span
              key={h}
              className="pointer-events-none absolute size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
              style={{ left: p.x, top: p.y }}
            />
          );
        })}

      <div
        className="absolute inset-x-0 bottom-6 flex justify-center px-4"
        style={{ cursor: "default" }}
        // The bar's own presses never start an area underneath it.
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div
          role="toolbar"
          aria-label="Record an area"
          className={`flex w-full max-w-[34rem] flex-wrap items-center justify-center gap-2 rounded-[14px] px-3 py-2 sm:flex-nowrap sm:justify-between ${GLASS_BAR}`}
        >
          <p
            aria-live="polite"
            className={`min-w-0 flex-1 basis-full text-center text-[13px] leading-snug sm:basis-auto sm:text-left ${notice ? "text-white" : GLASS_MUTED}`}
          >
            {hint}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void cancelCapture()}
              className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[8px] px-3 text-[13px] ${GLASS_BUTTON}`}
            >
              <X className="size-3.5" aria-hidden />
              Cancel
            </button>
            <button
              type="button"
              onClick={record}
              aria-disabled={!ready || sending}
              className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[8px] px-3 text-[13px] ${GLASS_PRIMARY} ${
                !ready || sending ? "opacity-45" : ""
              }`}
            >
              <Video className="size-3.5" aria-hidden />
              Record
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
