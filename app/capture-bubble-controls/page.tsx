"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { onTauriEvent } from "@/app/lib/utils/tauriListeners";
import { Pause, Play } from "lucide-react";
import "@/app/lib/capture/floating-window.css";
import {
  BUBBLE_CONTROLS_POINTER_EVENT,
  getCaptureCameraContext,
  getCaptureState,
  pauseCapture,
  resumeCapture,
  setCaptureCameraSize,
  type CaptureCameraState,
  type CapturePhase,
  type CapturePhaseEvent,
  type CaptureWindowPoint,
} from "@/app/lib/tauri/capture";
import { markedAt } from "@/app/lib/capture/rustHover";
import { GLASS_FOCUS } from "@/app/lib/capture/glass";
import { stepIndex } from "@/app/capture-overlay/keyNav";
import { nextRoundSize, sizeControls, type RoundSize } from "@/app/capture-camera/cameraDevices";
import { SizeGlyph } from "@/app/capture-camera/SizeGlyph";

/**
 * The camera bubble's own controls while a recording runs, Loom style: the
 * bubble's sizes (small, large, full) and pause / resume, on a small strip
 * over the bubble while the pointer is on it.
 *
 * This is a window of its own, never part of the bubble: the bubble's
 * window is filmed, so anything drawn in it is in the video. Rust opens this
 * window over the bubble, shows it while the pointer is on the bubble and
 * hides it otherwise (`bubble_controls`), and the recording leaves it out
 * (the macOS helper films only the main window and the bubble of Hippius's
 * windows; Windows protects it). Linux has none: nothing keeps a window out
 * of the recording there.
 *
 * Everything goes through the commands the pill uses, so the pill, the
 * bubble and the saved video agree: `capture_camera_set_size` (Rust saves
 * the size and moves the filmed window) and `capture_pause` /
 * `capture_resume`. The sizes show only where Rust offers them
 * (`resizeFromPill`), as in the pill's camera menu. The page decides
 * nothing: it mirrors Rust's phase and camera state.
 *
 * No native `title`: a system tooltip is a window of its own and could be
 * filmed. The button under the pointer or focus is named in the line above
 * the strip instead. Escape does nothing here, as on the pill.
 *
 * Which button the pointer is on comes from Rust (`capture_bubble_controls_pointer`,
 * from the camera's pointer watch): this window is never key, and on macOS
 * a webview in a window that is not key gets no hover, so `mouseenter` and
 * `:hover` never happened here and the line never named anything.
 */

function isLive(phase: CapturePhase): boolean {
  return phase.phase === "recording" || phase.phase === "paused";
}

const BUTTON = `grid size-7 place-items-center rounded-full transition-colors ${GLASS_FOCUS}`;
/** Marks each button with its place in the strip, for the hit test. */
const TIP_INDEX = "data-tip-index";

export default function CaptureBubbleControlsPage() {
  const [phase, setPhase] = useState<CapturePhase>({ phase: "idle" });
  const [camera, setCamera] = useState<CaptureCameraState | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which button is under the pointer or focus, named above the strip. */
  const [tipAt, setTipAt] = useState<number | null>(null);
  /** The round size before full size, for "Exit full size". */
  const [lastRound, setLastRound] = useState<RoundSize>("small");
  const [focusAt, setFocusAt] = useState(0);
  const stripRef = useRef<HTMLDivElement | null>(null);
  /** Where Rust says the pointer is on this window, and the button there. */
  const [pointer, setPointer] = useState<CaptureWindowPoint | null>(null);
  const [pointedAt, setPointedAt] = useState<number | null>(null);

  useEffect(() => {
    const unlisten = onTauriEvent<CaptureWindowPoint | null>(BUBBLE_CONTROLS_POINTER_EVENT, (e) => setPointer(e.payload));
    return () => {
      unlisten();
    };
  }, []);

  // The button under the pointer, read after every render: the strip under a
  // still pointer changes too (full size swaps its third button).
  // After every render on purpose; it sets state only when the element
  // under the pointer changed, so it settles at once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = markedAt(pointer, { left: 0, top: 0 }, TIP_INDEX);
    const at = el ? Number(el.getAttribute(TIP_INDEX)) : null;
    if (at !== pointedAt) setPointedAt(at);
  });

  useEffect(() => {
    // Rust numbers every phase: an older one (a first read that answers
    // after an event) never puts a stale phase back.
    let seq = -1;
    const take = (p: CapturePhaseEvent) => {
      if (typeof p.seq === "number") {
        if (p.seq <= seq) return;
        seq = p.seq;
      }
      setPhase(p);
    };
    let heardCamera = false;
    void getCaptureState()
      .then(take)
      .catch(() => undefined);
    void getCaptureCameraContext()
      .then((c) => !heardCamera && setCamera(c))
      .catch(() => undefined);
    const unlisteners = [
      onTauriEvent<CapturePhaseEvent>("capture_state_changed", (e) => take(e.payload)),
      onTauriEvent<CaptureCameraState>("capture_camera_state", (e) => {
        heardCamera = true;
        setCamera(e.payload);
      }),
    ];
    return () => {
      for (const stop of unlisteners) stop();
    };
  }, []);

  useEffect(() => {
    if (camera) setLastRound((last) => nextRoundSize(camera.size, last));
  }, [camera]);

  if (!isLive(phase) || camera?.shape !== "bubble" || camera.hidden) return null;

  const paused = phase.phase === "paused";
  const sizes = camera.resizeFromPill ? sizeControls(camera.size, lastRound) : [];
  const pauseLabel = paused ? "Resume recording" : "Pause recording";
  const labels = [...sizes.map((c) => c.label), pauseLabel];
  const tabStop = Math.min(focusAt, labels.length - 1);
  // By position, so the line follows the button's own label as it changes
  // (Pause becomes Resume under the pointer).
  // The pointer wins over keyboard focus while it is on a button.
  const shownAt = pointedAt ?? tipAt;
  const tip = shownAt === null ? null : (labels[shownAt] ?? null);

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch {
      // Rust refused (the recording ended meanwhile): its next phase or
      // camera state says what is true now.
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = Array.from(stripRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const next = stepIndex(e.key, buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length, "horizontal");
    if (next === null) return;
    e.preventDefault();
    setFocusAt(next);
    buttons[next]?.focus();
  };

  const named = (index: number) => ({
    "aria-label": labels[index],
    "aria-describedby": shownAt === index ? "bubble-controls-tip" : undefined,
    // One Tab stop into the strip; the arrows move along it.
    tabIndex: index === tabStop ? 0 : -1,
    [TIP_INDEX]: index,
    // Lit like `:hover`, which never happens in a window that is not key.
    "data-hover": pointedAt === index ? "true" : undefined,
    onFocus: () => {
      setTipAt(index);
      setFocusAt(index);
    },
    onBlur: () => setTipAt(null),
  });

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-end gap-1 pb-0.5" data-testid="bubble-controls">
      <span
        role="tooltip"
        id="bubble-controls-tip"
        aria-hidden={!tip}
        className={`pointer-events-none whitespace-nowrap rounded-md bg-[#000]/80 px-2 py-0.5 text-[11px] font-medium text-white transition-opacity duration-100 motion-reduce:transition-none ${
          tip ? "opacity-100" : "opacity-0"
        }`}
      >
        {tip ?? ""}
      </span>
      <div
        ref={stripRef}
        role="toolbar"
        aria-label="Camera and recording"
        onKeyDown={onKeyDown}
        className="flex items-center gap-0.5 rounded-full bg-[#000]/70 p-1 text-white shadow-lg backdrop-blur"
      >
        {sizes.map((c, i) => (
          <button
            key={c.key}
            type="button"
            aria-pressed={c.pressed}
            disabled={busy}
            {...named(i)}
            onClick={() => void run(() => setCaptureCameraSize(c.target))}
            className={`${BUTTON} ${c.pressed ? "bg-white/25" : "hover:bg-white/15 data-[hover=true]:bg-white/15"} disabled:opacity-40`}
          >
            <SizeGlyph icon={c.icon} />
          </button>
        ))}
        {sizes.length > 0 && <span aria-hidden className="mx-0.5 h-4 w-px bg-white/25" />}
        <button
          type="button"
          disabled={busy}
          {...named(sizes.length)}
          onClick={() => void run(paused ? resumeCapture : pauseCapture)}
          className={`${BUTTON} hover:bg-white/15 data-[hover=true]:bg-white/15 disabled:opacity-40`}
        >
          {paused ? <Play className="size-3.5 fill-current" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
        </button>
      </div>
    </div>
  );
}
