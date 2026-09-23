"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "./capture-overlay.css";
import {
  cancelCapture,
  getCaptureOverlayContext,
  selectCapture,
  type CaptureOverlayContext,
  type CaptureSelection,
  type CaptureWindowTarget,
  type LogicalRect,
} from "@/app/lib/tauri/capture";
import {
  dragRect,
  isRealDrag,
  sizeLabel,
  windowAt,
  type Point,
} from "./overlaySelection";

/**
 * The screen-capture selection overlay: one borderless, transparent,
 * content-protected window per display, opened by Rust's `capture_start`.
 *
 * It only draws and reports. Rust decides what the selection means in pixels,
 * takes the capture, and closes every overlay — this page never closes itself.
 *
 * The palette is fixed rather than themed: the overlay sits over OTHER apps'
 * windows, not over Hippius, so the app's light/dark setting says nothing
 * about what is underneath it. A neutral dim with a brand-blue frame reads on
 * any screen.
 */

const DIM = "rgba(0, 0, 0, 0.38)";
const FRAME = "#3167DD";

const HINTS = {
  area: { screenshot: "Drag to capture an area", recording: "Drag to record an area" },
  window: { screenshot: "Click a window to capture it", recording: "Click a window to record it" },
  screen: { screenshot: "Click to capture this screen", recording: "Click to record this screen" },
} as const;

function displayIdFromLocation(): number | null {
  const raw = new URLSearchParams(window.location.search).get("display");
  const id = raw === null ? NaN : Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

export default function CaptureOverlayPage() {
  const [context, setContext] = useState<CaptureOverlayContext | null>(null);
  const [drag, setDrag] = useState<{ start: Point; current: Point } | null>(null);
  const [hovered, setHovered] = useState<CaptureWindowTarget | null>(null);
  // One answer per overlay: a double click must not submit twice.
  const submitted = useRef(false);

  useEffect(() => {
    const displayId = displayIdFromLocation();
    if (displayId === null) {
      void cancelCapture();
      return;
    }
    getCaptureOverlayContext(displayId)
      .then(setContext)
      // No session waiting (it ended while this window was opening): nothing
      // to select, so stand down rather than sit over the screen.
      .catch(() => void cancelCapture());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void cancelCapture();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = useCallback((selection: CaptureSelection) => {
    if (submitted.current) return;
    submitted.current = true;
    selectCapture(selection).catch(() => {
      // Rust has already reported the failure (notification + event); let
      // the user try again from this overlay if it is still up.
      submitted.current = false;
    });
  }, []);

  if (!context) return null;
  const { mode, displayId, kind } = context;

  const pointFrom = (e: React.PointerEvent): Point => ({ x: e.clientX, y: e.clientY });

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (mode === "area") {
      const p = pointFrom(e);
      setDrag({ start: p, current: p });
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointFrom(e);
    if (mode === "area" && drag) setDrag({ ...drag, current: p });
    if (mode === "window") setHovered(windowAt(context.windows, p));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (mode === "area" && drag) {
      const rect = dragRect(drag.start, pointFrom(e));
      setDrag(null);
      if (isRealDrag(rect)) submit({ target: "area", displayId, rect });
    } else if (mode === "window") {
      const target = windowAt(context.windows, pointFrom(e));
      if (target) submit({ target: "window", windowId: target.id });
    } else if (mode === "screen") {
      submit({ target: "screen", displayId });
    }
  };

  const selection: LogicalRect | null =
    mode === "area" && drag ? dragRect(drag.start, drag.current) : mode === "window" ? hovered : null;

  return (
    <div
      className="fixed inset-0 select-none"
      style={{ cursor: mode === "area" ? "crosshair" : "pointer", background: selection ? "transparent" : DIM }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {selection && (
        <div
          className="pointer-events-none absolute"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
            // The dim is a shadow spread from the selection, so everything
            // outside it darkens and the selection itself stays clear.
            boxShadow: `0 0 0 100vmax ${DIM}`,
            outline: `2px solid ${FRAME}`,
          }}
        >
          {mode === "area" && isRealDrag(selection) && (
            <span className="absolute -bottom-7 right-0 rounded-md bg-black/75 px-2 py-0.5 text-xs font-medium text-white tabular-nums">
              {sizeLabel(selection)}
            </span>
          )}
        </div>
      )}

      {mode === "screen" && (
        <div className="pointer-events-none absolute inset-0" style={{ outline: `3px solid ${FRAME}`, outlineOffset: -3 }} />
      )}

      <div className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-sm text-white shadow-lg">
        {HINTS[mode][kind]}
        <span className="ml-3 text-white/60">Esc to cancel</span>
      </div>
    </div>
  );
}
