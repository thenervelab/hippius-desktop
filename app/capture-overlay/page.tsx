"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Camera, Video } from "lucide-react";
import "./capture-overlay.css";
import {
  cancelCapture,
  confirmCapture,
  getCaptureOverlayContext,
  selectCapture,
  setCaptureMode,
  setCapturePending,
  type CaptureKind,
  type CaptureMode,
  type CaptureOverlayContext,
  type CapturePhase,
  type CaptureSelection,
  type CaptureWindowTarget,
  type LogicalRect,
} from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import CaptureBar from "./CaptureBar";
import { barHint, LAST_AREA_KEY } from "./barText";
import {
  dragRect,
  fitRect,
  HANDLES,
  handlePoint,
  hitTest,
  isRealDrag,
  moveRect,
  resizeRect,
  sizeLabel,
  windowAt,
  type Handle,
  type Point,
} from "./overlaySelection";

/**
 * The screen-capture overlay: one borderless, transparent, content-protected
 * window per display, opened by Rust's `capture_start`. The one on the display
 * the pointer was on also draws the capture bar.
 *
 * It only draws and reports. An area drawn here is handed to Rust
 * (`capture_set_pending`) so the bar's Capture button can take it from any
 * display; Rust decides what a selection means in pixels, takes the capture,
 * and closes every overlay. This page never closes itself.
 *
 * The palette is fixed rather than themed: the overlay sits over OTHER apps'
 * windows, not over Hippius, so the app's light/dark setting says nothing
 * about what is underneath it.
 */

const DIM = "rgba(0, 0, 0, 0.38)";
const FRAME = "#3167DD";

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

function displayIdFromLocation(): number | null {
  const raw = new URLSearchParams(window.location.search).get("display");
  const id = raw === null ? NaN : Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function readLastArea(): { displayId: number; rect: LogicalRect } | null {
  try {
    const raw = localStorage.getItem(LAST_AREA_KEY);
    return raw ? (JSON.parse(raw) as { displayId: number; rect: LogicalRect }) : null;
  } catch {
    return null;
  }
}

function saveLastArea(displayId: number, rect: LogicalRect) {
  try {
    localStorage.setItem(LAST_AREA_KEY, JSON.stringify({ displayId, rect }));
  } catch {
    // Remembering the area is a convenience; nothing breaks without it.
  }
}

const bounds = () => ({ width: window.innerWidth, height: window.innerHeight });

export default function CaptureOverlayPage() {
  const displayId = useMemo(() => (typeof window === "undefined" ? null : displayIdFromLocation()), []);
  const [context, setContext] = useState<CaptureOverlayContext | null>(null);
  // The area on THIS display; an area on another display empties it.
  const [rect, setRect] = useState<LogicalRect | null>(null);
  const [areaElsewhere, setAreaElsewhere] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hovered, setHovered] = useState<CaptureWindowTarget | null>(null);
  const [pointerHere, setPointerHere] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingAction = useRef<(() => Promise<void>) | null>(null);
  const submitted = useRef(false);
  const restored = useRef(false);

  const load = useCallback(async () => {
    if (displayId === null) return;
    const ctx = await getCaptureOverlayContext(displayId);
    setContext(ctx);
    if (restored.current) return;
    restored.current = true;
    const pending = ctx.pending;
    if (pending?.target === "area") {
      if (pending.displayId === displayId) setRect(pending.rect);
      else setAreaElsewhere(true);
      return;
    }
    // macOS brings back the last area; so does this, on the display it was on.
    const last = readLastArea();
    const fitted = last && last.displayId === displayId ? fitRect(last.rect, bounds()) : null;
    if (fitted) {
      setRect(fitted);
      void setCapturePending({ target: "area", displayId, rect: fitted }).catch(() => undefined);
    }
  }, [displayId]);

  useEffect(() => {
    if (displayId === null) {
      void cancelCapture();
      return;
    }
    // No session waiting (it ended while this window was opening): nothing
    // to select, so stand down rather than sit over the screen.
    load().catch(() => void cancelCapture());
  }, [displayId, load]);

  // The bar switched mode on some display: read the context again (window
  // mode needs this display's window list). The drawn area survives.
  useEffect(() => {
    const unlisteners = [
      listen<CapturePhase>("capture_state_changed", (e) => {
        if (e.payload.phase === "selecting") {
          setHovered(null);
          void load().catch(() => undefined);
        }
      }),
      listen<{ displayId: number | null }>("capture_pending_changed", (e) => {
        const other = e.payload.displayId !== null && e.payload.displayId !== displayId;
        setAreaElsewhere(other);
        if (other) setRect(null);
      }),
    ];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, [displayId, load]);

  /** Run `action` after the countdown, if there is one. */
  const withCountdown = useCallback(
    (action: () => Promise<void>) => {
      if (submitted.current || !context) return;
      submitted.current = true;
      setNotice(null);
      const run = () =>
        action().catch((error) => {
          // Rust has already reported a capture failure; a refusal (nothing
          // drawn yet) is shown here and the user can carry on.
          setNotice(errorMessage(error));
          setCountdown(null);
          submitted.current = false;
        });
      if (context.countdownSecs > 0) {
        pendingAction.current = run;
        setCountdown(context.countdownSecs);
      } else {
        void run();
      }
    },
    [context],
  );

  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      const action = pendingAction.current;
      pendingAction.current = null;
      void action?.();
      return;
    }
    const t = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [countdown]);

  const confirm = useCallback(() => {
    if (!context || displayId === null) return;
    if (context.mode === "window") {
      setNotice(barHint(context.kind, "window", false));
      return;
    }
    withCountdown(() => confirmCapture(displayId));
  }, [context, displayId, withCountdown]);

  const submitSelection = useCallback(
    (selection: CaptureSelection) => withCountdown(() => selectCapture(selection)),
    [withCountdown],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (countdown !== null) {
          // Esc during the countdown stops it, not the whole capture.
          pendingAction.current = null;
          setCountdown(null);
          submitted.current = false;
          return;
        }
        void cancelCapture();
      } else if (e.key === "Enter" && countdown === null) {
        confirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, countdown]);

  if (!context || displayId === null) return null;
  const { mode, kind } = context;
  const counting = countdown !== null;

  const pointFrom = (e: React.PointerEvent): Point => ({ x: e.clientX, y: e.clientY });

  const commitArea = (next: LogicalRect | null) => {
    setRect(next);
    if (next && isRealDrag(next)) {
      saveLastArea(displayId, next);
      void setCapturePending({ target: "area", displayId, rect: next }).catch(() => undefined);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || counting) return;
    const p = pointFrom(e);
    if (mode === "area") {
      const hit = rect ? hitTest(rect, p) : null;
      if (hit === "move") setDrag({ op: "move", last: p });
      else if (hit) setDrag({ op: "resize", handle: hit });
      else setDrag({ op: "create", start: p, current: p });
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointFrom(e);
    setPointerHere(true);
    if (counting) return;
    if (mode === "window") setHovered(windowAt(context.windows, p));
    if (mode !== "area" || !drag) return;
    if (drag.op === "create") setDrag({ ...drag, current: p });
    else if (drag.op === "move" && rect) {
      setRect(moveRect(rect, p.x - drag.last.x, p.y - drag.last.y, bounds()));
      setDrag({ op: "move", last: p });
    } else if (drag.op === "resize" && rect) {
      setRect(resizeRect(rect, drag.handle, p, bounds()));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.button !== 0 || counting) return;
    const p = pointFrom(e);
    if (mode === "area" && drag) {
      if (drag.op === "create") {
        const created = dragRect(drag.start, p);
        // A click without a drag keeps the area that was there.
        if (isRealDrag(created)) commitArea(created);
      } else {
        commitArea(rect);
      }
      setDrag(null);
    } else if (mode === "window") {
      const target = windowAt(context.windows, p);
      if (target) submitSelection({ target: "window", windowId: target.id });
    } else if (mode === "screen") {
      submitSelection({ target: "screen", displayId });
    }
  };

  const liveArea: LogicalRect | null =
    mode === "area" ? (drag?.op === "create" ? dragRect(drag.start, drag.current) : rect) : null;
  const highlight: LogicalRect | null = mode === "area" ? liveArea : mode === "window" ? hovered : null;
  const screenLit = mode === "screen" && pointerHere;

  const cursor =
    counting
      ? "default"
      : mode === "area"
        ? drag?.op === "resize"
          ? CURSOR[drag.handle]
          : drag?.op === "move"
            ? "grabbing"
            : "crosshair"
        : "pointer";

  const onMode = (nextKind: CaptureKind, nextMode: CaptureMode) => {
    setNotice(null);
    void setCaptureMode(nextKind, nextMode).catch((error) => setNotice(errorMessage(error)));
  };

  const hint = notice ?? barHint(kind, mode, Boolean(rect) || areaElsewhere);
  const KindIcon = kind === "recording" ? Video : Camera;

  return (
    <div
      className="fixed inset-0 select-none"
      style={{ cursor, background: highlight || screenLit ? "transparent" : DIM }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        setPointerHere(false);
        setHovered(null);
      }}
      onDoubleClick={() => {
        if (mode === "area" && rect) confirm();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {highlight && (
        <div
          className="pointer-events-none absolute"
          style={{
            left: highlight.x,
            top: highlight.y,
            width: highlight.width,
            height: highlight.height,
            // The dim is a shadow spread from the selection, so everything
            // outside it darkens and the selection itself stays clear.
            boxShadow: `0 0 0 100vmax ${DIM}`,
            outline: mode === "area" ? "1px dashed rgba(255,255,255,0.95)" : `2px solid ${FRAME}`,
            background: mode === "window" ? "rgba(49,103,221,0.16)" : "transparent",
          }}
        >
          {mode === "area" && isRealDrag(highlight) && !counting && (
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-black/60 px-2 py-0.5 text-xs font-medium tabular-nums text-white">
              {sizeLabel(highlight)}
            </span>
          )}
          {mode === "window" && hovered && !counting && (
            <span className="absolute left-1/2 top-1/2 flex max-w-[80%] -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-black/75 px-3.5 py-2 text-sm font-medium text-white shadow-lg">
              <KindIcon className="size-4 shrink-0" />
              <span className="truncate">{hovered.appName || hovered.title || "Window"}</span>
            </span>
          )}
        </div>
      )}

      {mode === "area" && rect && !drag && !counting &&
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

      {screenLit && (
        <div className="pointer-events-none absolute inset-0" style={{ outline: `3px solid ${FRAME}`, outlineOffset: -3 }}>
          {!counting && (
            <span className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm font-medium text-white shadow-lg">
              <KindIcon className="size-4" />
              {kind === "recording" ? "Click to record this screen" : "Click to capture this screen"}
            </span>
          )}
        </div>
      )}

      {counting && (
        <div
          className="pointer-events-none absolute grid size-24 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-5xl font-semibold tabular-nums text-white"
          style={{
            left: highlight ? highlight.x + highlight.width / 2 : "50%",
            top: highlight ? highlight.y + highlight.height / 2 : "50%",
          }}
          aria-live="assertive"
        >
          {countdown}
        </div>
      )}

      {context.hostsBar && !counting && (
        <CaptureBar
          kind={kind}
          mode={mode}
          options={context.options}
          destination={context.destination}
          recordingAvailable={context.recordingAvailable}
          microphoneAvailable={context.microphoneAvailable}
          showClicksAvailable={context.showClicksAvailable}
          hint={hint}
          onMode={onMode}
          onConfirm={confirm}
          onCancel={() => void cancelCapture()}
          onOptionsSaved={(options) =>
            setContext((c) => (c ? { ...c, options, countdownSecs: kind === "recording" ? c.countdownSecs : options.timerSecs } : c))
          }
          onDestinationSaved={(destination) => setContext((c) => (c ? { ...c, destination } : c))}
        />
      )}
    </div>
  );
}
