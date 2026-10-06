"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Camera, Video } from "lucide-react";
import "@/app/lib/capture/floating-window.css";
import {
  cancelCapture,
  confirmCapture,
  getCaptureCameraContext,
  getCaptureOverlayContext,
  holdCaptureBar,
  refreshCaptureWindows,
  selectCapture,
  setCaptureMode,
  setCapturePending,
  type CameraShape,
  type CaptureCameraState,
  type CaptureKind,
  type CaptureMode,
  type CaptureOptions,
  type CaptureOverlayContext,
  type CapturePhase,
  type CaptureSelection,
  type CaptureWindowTarget,
  type LogicalRect,
  type ShareTab,
} from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { CAPTURE_ACCENT, GLASS_FOCUS, GLASS_PANEL } from "@/app/lib/capture/glass";
import { enterKeyName } from "@/app/lib/capture/shortcutLabel";
import { disabledRecordingNote, supportedModesOf } from "@/app/lib/capture/modes";
import CaptureBar from "./CaptureBar";
import SharePicker from "./SharePicker";
import { barHint, instantHint, LAST_AREA_KEY, panelHint } from "./barText";
import { isFromControl } from "./keyNav";
import { selectionFor, type SharePick } from "./sharePickerState";
import { pollWindows } from "./windowRefresh";
import { captureCursor, isClickToCapture, spaceToggleMode } from "./clickCapture";
import {
  dragRect,
  fitRect,
  HANDLES,
  handlePoint,
  hitTest,
  applyPending,
  isRealDrag,
  moveRect,
  nudgeRect,
  resizeRect,
  shiftDrag,
  sizeLabel,
  windowAt,
  type Handle,
  type PendingChange,
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
 *
 * Where Rust's `selection` is `systemPicker` (a Wayland recording) this page
 * is the PANEL instead: one small window with the capture bar and no
 * selection surface, since Hippius can neither cover the screen nor see
 * other windows there. Record goes straight to Rust, which has the
 * desktop's own screen-sharing dialog choose the window or screen.
 */

const DIM = "rgba(0, 0, 0, 0.38)";
const FRAME = CAPTURE_ACCENT;

type Drag =
  // `last`: where the pointer was, for a hold-Space move (`shiftDrag`).
  | { op: "create"; start: Point; current: Point; last?: Point }
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

/** Rust opened this overlay for the shortcut's one-step screenshot: a crosshair before the context loads. */
function instantFromLocation(): boolean {
  return new URLSearchParams(window.location.search).get("instant") === "1";
}

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
  const instantRequested = useMemo(() => (typeof window === "undefined" ? false : instantFromLocation()), []);
  const [context, setContext] = useState<CaptureOverlayContext | null>(null);
  // The area on THIS display; an area on another display empties it.
  const [rect, setRect] = useState<LogicalRect | null>(null);
  const [areaElsewhere, setAreaElsewhere] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hovered, setHovered] = useState<CaptureWindowTarget | null>(null);
  const [pointerHere, setPointerHere] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The camera window Rust is showing; a "stage" means the camera alone is
  // recorded, so there is nothing on the screen to choose.
  const [cameraShape, setCameraShape] = useState<CameraShape | null>(null);
  // "Choose what to share" is open on this tab; it owns the keyboard then.
  const [picker, setPicker] = useState<ShareTab | null>(null);
  // The capture itself is running (the countdown ended, or there was none):
  // Rust closes this window when it is done, or answers a refusal.
  const [inFlight, setInFlight] = useState(false);
  const pendingAction = useRef<(() => Promise<void>) | null>(null);
  const submitted = useRef(false);
  const inFlightRef = useRef(false);
  const restored = useRef(false);
  // The area this overlay last handed to Rust, drawn again when Rust says
  // this display holds the pending area (see `applyPending`).
  const handedOver = useRef<LogicalRect | null>(null);
  // Space is held while a new area is dragged: the area moves (macOS's ⌘⇧4).
  const spaceHeld = useRef(false);
  // Where the pointer last was, so a refreshed window list re-picks the hover.
  const lastPoint = useRef<Point | null>(null);
  // What the key handler needs from the latest render, without re-binding.
  const latest = useRef<{
    rect: LogicalRect | null;
    nudge: ((next: LogicalRect) => void) | null;
    dragging: boolean;
    creating: boolean;
  }>({
    rect: null,
    nudge: null,
    dragging: false,
    creating: false,
  });

  const load = useCallback(async () => {
    if (displayId === null) return;
    const ctx = await getCaptureOverlayContext(displayId);
    setContext(ctx);
    if (restored.current) return;
    restored.current = true;
    // The shortcut's one-step shot starts with nothing drawn.
    if (ctx.instant) return;
    const pending = ctx.pending;
    if (pending?.target === "area") {
      if (pending.displayId === displayId) {
        handedOver.current = pending.rect;
        setRect(pending.rect);
      } else setAreaElsewhere(true);
      return;
    }
    // macOS brings back the last area; so does this, on the display it was on.
    const last = readLastArea();
    const fitted = last && last.displayId === displayId ? fitRect(last.rect, bounds()) : null;
    if (fitted) {
      handedOver.current = fitted;
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
    void getCaptureCameraContext()
      .then((c) => setCameraShape(c.shape))
      .catch(() => undefined);
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
      listen<CaptureCameraState>("capture_camera_state", (e) => setCameraShape(e.payload.shape)),
      // The camera's own size strip or its × saved the options: keep the
      // bar's copy current, or its next save would write the old one back.
      listen<CaptureOptions>("capture_options_changed", (e) =>
        setContext((c) => (c ? { ...c, options: e.payload } : c)),
      ),
      listen<PendingChange>("capture_pending_changed", (e) => {
        if (displayId === null) return;
        const next = applyPending(displayId, e.payload, handedOver.current);
        setAreaElsewhere(next.elsewhere);
        if (next.rect !== undefined) setRect(next.rect);
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
      // `submitted` stays set until the action settles: a second Return
      // while Rust is taking the capture must not start another countdown.
      const run = () => {
        inFlightRef.current = true;
        setInFlight(true);
        setCountdown(null);
        return action()
          .catch((error) => {
            // Rust has already reported a capture failure; a refusal (nothing
            // drawn yet) is shown here and the user can carry on.
            setNotice(errorMessage(error));
            submitted.current = false;
          })
          .finally(() => {
            inFlightRef.current = false;
            setInFlight(false);
          });
      };
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

  /** Go now: the numeral clicked, or Return while counting. The effect above runs the waiting action. */
  const skipCountdown = useCallback(() => {
    setCountdown((c) => (c !== null && c > 0 ? 0 : c));
  }, []);

  // Window mode: ask Rust for this display's windows again while the bar is
  // up, so a window that moved or opened highlights where it is now. Stops
  // with the mode, the count, or a hidden page.
  const pollingWindows =
    displayId !== null &&
    context?.selection !== "systemPicker" &&
    context?.mode === "window" &&
    !(context.kind === "recording" && cameraShape === "stage") &&
    countdown === null &&
    !inFlight;
  useEffect(() => {
    if (!pollingWindows || displayId === null) return;
    return pollWindows(
      () => refreshCaptureWindows(displayId),
      (windows) => {
        setContext((c) => (c && c.mode === "window" ? { ...c, windows } : c));
        const at = lastPoint.current;
        setHovered((prev) => (prev && at ? windowAt(windows, at) : prev));
      },
    );
  }, [pollingWindows, displayId]);

  const confirm = useCallback(() => {
    if (!context || displayId === null) return;
    const cameraOnly = context.kind === "recording" && cameraShape === "stage";
    // The panel has no window to click: the desktop's dialog picks one.
    if (context.mode === "window" && !cameraOnly && context.selection !== "systemPicker") {
      setNotice(barHint(context.kind, "window", false));
      return;
    }
    withCountdown(() => confirmCapture(displayId));
  }, [context, displayId, withCountdown, cameraShape]);

  const submitSelection = useCallback(
    (selection: CaptureSelection) => withCountdown(() => selectCapture(selection)),
    [withCountdown],
  );

  const chooseShared = useCallback(
    (pick: SharePick) => {
      setPicker(null);
      submitSelection(selectionFor(pick));
    },
    [submitSelection],
  );

  // The key handler reads this render's state. It is published through a ref
  // in a layout effect and the window listener is bound once, so a key
  // pressed the moment the bar appears acts on the context that drew it: a
  // listener re-bound in a passive effect kept the previous render's
  // closure until React got round to that effect, and the bar's first
  // render comes from an async context load, whose effects run a task later.
  const onKey = (e: KeyboardEvent) => {
    // The picker answers Return (share the pick) and Escape (close it,
    // leaving the capture bar up) itself; an open bar menu takes the key
    // first and marks it handled.
    if (picker !== null || e.defaultPrevented) return;
    if (e.key === "Escape") {
      if (countdown !== null && !inFlightRef.current) {
        // Esc during the countdown stops it, not the whole capture.
        pendingAction.current = null;
        setCountdown(null);
        submitted.current = false;
        return;
      }
      // Nothing to stop short of the capture itself, including one Rust
      // is already taking: cancel it.
      void cancelCapture();
      return;
    }
    // Return on a focused bar button is that button's (Options opens its
    // menu); only a Return aimed at the screen takes the capture.
    if (isFromControl(e.target)) return;
    if (e.key === "Enter") {
      if (countdown === null) confirm();
      else if (!inFlightRef.current) skipCountdown();
      return;
    }
    if (countdown !== null || inFlightRef.current) return;
    // Held while a new area is dragged, Space moves the area instead.
    if (e.key === " " && latest.current.creating) {
      e.preventDefault();
      spaceHeld.current = true;
      return;
    }
    // Space swaps window and area, as it does in macOS's ⌘⇧4. Not mid-drag,
    // and not with the camera alone (nothing on screen is chosen then).
    if (e.key === " " && context && context.selection !== "systemPicker" && !latest.current.dragging) {
      const stage = context.kind === "recording" && cameraShape === "stage";
      const next = stage ? null : spaceToggleMode(context.mode, context.kind, supportedModesOf(context));
      if (next) {
        e.preventDefault();
        setNotice(null);
        void setCaptureMode(context.kind, next).catch((error) => setNotice(errorMessage(error)));
      }
      return;
    }
    const { rect: area, nudge } = latest.current;
    const next = area && nudge ? nudgeRect(area, e.key, e.shiftKey, bounds()) : null;
    if (next && nudge) {
      e.preventDefault();
      nudge(next);
    }
  };

  const keyHandler = useRef(onKey);
  useLayoutEffect(() => {
    keyHandler.current = onKey;
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandler.current(e);
    const release = (e: KeyboardEvent) => {
      if (e.key === " ") spaceHeld.current = false;
    };
    window.addEventListener("keydown", listener);
    window.addEventListener("keyup", release);
    return () => {
      window.removeEventListener("keydown", listener);
      window.removeEventListener("keyup", release);
    };
  }, []);

  // Rust moves the bar to whichever display the pointer settles on. The
  // overlay drawing it holds it here while moving it would lose what the
  // user is doing: a countdown or capture under way, a drag, the share
  // picker. Only the bar's overlay says so; the others have nothing to hold.
  const hostsBar = context?.hostsBar === true;
  const holdsBar = countdown !== null || inFlight || drag !== null || picker !== null;
  useEffect(() => {
    if (!hostsBar) return;
    void holdCaptureBar(holdsBar).catch(() => undefined);
  }, [hostsBar, holdsBar]);

  if (!context || displayId === null) {
    // The shortcut's shot: the crosshair is there from the first frame.
    return instantRequested ? <div data-testid="capture-instant-pending" className="fixed inset-0" style={{ cursor: "crosshair" }} /> : null;
  }
  const { kind } = context;
  const cameraOnly = kind === "recording" && cameraShape === "stage";
  // Camera only: the stage is what is recorded, so no area, window or screen
  // is chosen here. "none" switches every selection path below off.
  const mode: CaptureMode | "none" = cameraOnly ? "none" : context.mode;
  // The bar and the handles stay down from the count until Rust closes the window.
  const counting = countdown !== null || inFlight;

  const pointFrom = (e: React.PointerEvent): Point => ({ x: e.clientX, y: e.clientY });

  const commitArea = (next: LogicalRect | null) => {
    setRect(next);
    if (next && isRealDrag(next)) {
      handedOver.current = next;
      saveLastArea(displayId, next);
      void setCapturePending({ target: "area", displayId, rect: next }).catch(() => undefined);
    }
  };
  latest.current = {
    rect: mode === "area" && !drag ? rect : null,
    nudge: commitArea,
    dragging: drag !== null,
    creating: mode === "area" && drag?.op === "create",
  };
  const instant = context.instant;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || counting) return;
    const p = pointFrom(e);
    if (mode === "area") {
      const hit = rect ? hitTest(rect, p) : null;
      if (hit === "move") setDrag({ op: "move", last: p });
      else if (hit) setDrag({ op: "resize", handle: hit });
      else {
        spaceHeld.current = false;
        setDrag({ op: "create", start: p, current: p, last: p });
      }
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointFrom(e);
    lastPoint.current = p;
    setPointerHere(true);
    if (counting) return;
    if (mode === "window") setHovered(windowAt(context.windows, p));
    if (mode !== "area" || !drag) return;
    if (drag.op === "create") {
      const last = drag.last ?? drag.current;
      if (spaceHeld.current) {
        const moved = shiftDrag(drag.start, drag.current, p.x - last.x, p.y - last.y, bounds());
        setDrag({ op: "create", ...moved, last: p });
      } else setDrag({ op: "create", start: drag.start, current: p, last: p });
    }
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
        // The area as drawn: the pointer, or where a hold-Space move left it.
        const created = dragRect(drag.start, spaceHeld.current ? drag.current : p);
        spaceHeld.current = false;
        if (instant) {
          // The shortcut's shot: releasing the drag takes it. A click
          // without a drag does nothing; the crosshair stays.
          if (isRealDrag(created)) {
            setRect(created);
            submitSelection({ target: "area", displayId, rect: created });
          }
        } else if (isRealDrag(created)) {
          // A click without a drag keeps the area that was there.
          commitArea(created);
        }
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

  // Window and screen are click-to-capture: the camera cursor (a record-dot
  // camera for recordings), as in macOS's ⌘⇧4 then Space.
  const cursor =
    counting || mode === "none"
      ? "default"
      : mode === "area"
        ? drag?.op === "resize"
          ? CURSOR[drag.handle]
          : drag?.op === "move"
            ? "grabbing"
            : "crosshair"
        : isClickToCapture(mode)
          ? captureCursor(kind)
          : "pointer";

  const onMode = (nextKind: CaptureKind, nextMode: CaptureMode) => {
    setNotice(null);
    void setCaptureMode(nextKind, nextMode).catch((error) => setNotice(errorMessage(error)));
  };

  const enterKey = enterKeyName();
  const spaceForArea = spaceToggleMode(context.mode, kind, supportedModesOf(context)) === "area";
  const hint =
    notice ?? barHint(kind, context.mode, Boolean(rect) || areaElsewhere, cameraOnly, enterKey, spaceForArea);
  // Said once with what it is counting to, then the bare numbers.
  const countdownSpeech =
    countdown === null || countdown <= 0
      ? ""
      : countdown === context.countdownSecs
        ? `${kind === "recording" ? "Recording" : "Capturing"} in ${countdown}`
        : String(countdown);
  const KindIcon = kind === "recording" ? Video : Camera;

  const captureBar = (barHintText: string, panel = false) => (
    <CaptureBar
      kind={kind}
      mode={context.mode}
      cameraOnly={cameraOnly}
      options={context.options}
      destination={context.destination}
      recordingAvailable={context.recordingAvailable}
      recordingNote={disabledRecordingNote(context)}
      microphoneAvailable={context.microphoneAvailable}
      microphoneUnavailableMessage={context.microphoneUnavailableMessage}
      cameraUnavailableMessage={context.cameraUnavailableMessage ?? null}
      privacyBlocked={context.privacyBlocked}
      continuityHint={context.continuityHint}
      showClicksAvailable={context.showClicksAvailable}
      modes={context.modes}
      screenshotTimer={context.screenshotTimer}
      systemAudioAvailable={context.systemAudio}
      cameraOnlyAvailable={context.cameraOnlyAvailable}
      cameraFilmed={context.cameraFilmed}
      recordCountdown={context.recordCountdown}
      chooseAvailable={!panel}
      hint={barHintText}
      enterKey={enterKey}
      onMode={onMode}
      onChoose={(tab) => {
        setNotice(null);
        setPicker(tab);
      }}
      onConfirm={confirm}
      onCancel={() => void cancelCapture()}
      onOptionsSaved={(saved) =>
        // Rust says what the countdown and the camera are now; the bar does not work them out.
        setContext((c) =>
          c ? { ...c, options: saved.options, countdownSecs: saved.countdownSecs, cameraFilmed: saved.cameraFilmed } : c,
        )
      }
    />
  );

  if (context.selection === "systemPicker") {
    // The panel: an ordinary window the compositor places, holding the bar.
    // Dragging its empty part moves it; Escape and the bar's close button
    // cancel, Return or Record go on to the desktop's dialog.
    return (
      <div className="fixed inset-0 select-none" onContextMenu={(e) => e.preventDefault()}>
        <div
          data-testid="capture-panel"
          data-tauri-drag-region
          className={`absolute inset-0 rounded-[18px] ${GLASS_PANEL}`}
        />
        <p className="sr-only" aria-live="assertive" aria-atomic="true">
          {countdownSpeech}
        </p>
        {context.hostsBar && !counting && (
          <div data-testid="capture-bar-slot">{captureBar(notice ?? panelHint(context.mode, enterKey, cameraOnly), true)}</div>
        )}
      </div>
    );
  }

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
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-[#000]/60 px-2 py-0.5 text-xs font-medium tabular-nums text-white">
              {sizeLabel(highlight)}
            </span>
          )}
          {mode === "window" && hovered && !counting && (
            <span className="absolute left-1/2 top-1/2 flex max-w-[80%] -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-[#000]/75 px-3.5 py-2 text-sm font-medium text-white shadow-lg">
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
        <div
          className="pointer-events-none absolute inset-0"
          // A light tint as well as the frame: the display under the pointer
          // is the one a click (or Return) takes.
          style={{ outline: `3px solid ${FRAME}`, outlineOffset: -3, background: "rgba(49,103,221,0.08)" }}
        >
          {!counting && (
            <span className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-[#000]/70 px-4 py-2 text-sm font-medium text-white shadow-lg">
              <KindIcon className="size-4" />
              {kind === "recording" ? "Click to record this screen" : "Click to capture this screen"}
            </span>
          )}
        </div>
      )}

      {/* Always mounted: a live region that appears with its first number
          is often not announced at all. */}
      <p className="sr-only" aria-live="assertive" aria-atomic="true">
        {countdownSpeech}
      </p>

      {countdown !== null && countdown > 0 && (
        // Clicking the count goes at once, as Return does.
        <button
          type="button"
          aria-label={`${kind === "recording" ? "Record" : "Capture"} now`}
          title={`${kind === "recording" ? "Record" : "Capture"} now (${enterKey})`}
          onClick={skipCountdown}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          className={`absolute grid size-24 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full bg-[#000]/60 text-5xl font-semibold tabular-nums text-white hover:bg-[#000]/75 ${GLASS_FOCUS}`}
          style={{
            left: highlight ? highlight.x + highlight.width / 2 : "50%",
            // Camera only: the stage fills the middle and sits above this
            // window, so the count goes above it.
            top: highlight ? highlight.y + highlight.height / 2 : cameraOnly ? "11%" : "50%",
          }}
        >
          <span aria-hidden>{countdown}</span>
        </button>
      )}

      {context.hostsBar && !counting && !instant && (
        // The bar stays up but out of the way of click-to-capture: over it the
        // pointer is a plain arrow and no window is lit, and its own handlers
        // keep a click on it from choosing anything underneath.
        <div data-testid="capture-bar-slot" style={{ cursor: "default" }} onPointerEnter={() => setHovered(null)}>
          {captureBar(hint)}
        </div>
      )}

      {context.hostsBar && instant && !counting && !drag && (
        // No bar on the shortcut's shot: one line says what to do. It takes
        // no pointer events, so the drag can start right over it.
        <p
          data-testid="capture-instant-hint"
          role="status"
          className="pointer-events-none absolute left-1/2 top-6 max-w-[90vw] -translate-x-1/2 rounded-full bg-[#000]/70 px-4 py-2 text-center text-sm font-medium text-white shadow-lg"
        >
          {notice ?? instantHint(context.mode, spaceToggleMode(context.mode, kind, supportedModesOf(context)) === "window")}
        </p>
      )}

      {context.hostsBar && picker !== null && !counting && (
        <SharePicker
          kind={kind}
          firstTab={picker}
          barDisplayId={displayId}
          onChoose={chooseShared}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
