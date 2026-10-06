"use client";

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronUp, Mic, MicOff, Pause, Play, RotateCcw, Square, Trash2, Video, VideoOff, VolumeX, X } from "lucide-react";
import "@/app/lib/capture/floating-window.css";
import {
  DEVICE_LOST_EVENT,
  MICROPHONE_STATE_EVENT,
  PILL_COUNTDOWN_EVENT,
  cancelCapture,
  getCaptureCameraContext,
  getCaptureControlsContext,
  getCaptureMicrophoneState,
  getCaptureState,
  muteCaptureMicrophone,
  pauseCapture,
  restartCapture,
  resumeCapture,
  setCaptureControlsMenu,
  skipCaptureCountdown,
  stopCapture,
  toggleCaptureCamera,
  type CaptureCameraState,
  type CaptureDeviceLost,
  type CaptureMicrophoneState,
  type CapturePhase,
  type CapturePhaseEvent,
} from "@/app/lib/tauri/capture";
import { GLASS_BUTTON, GLASS_FOCUS, GLASS_PILL } from "@/app/lib/capture/glass";
import { mmss } from "@/app/lib/capture/time";
import { discardNeedsConfirm } from "./discard";
import { PillMenu, type PillMenuKind } from "./PillMenu";

/**
 * Floating recording pill: time, microphone, camera, pause/resume, restart,
 * stop, discard.
 *
 * Mid-recording, where Rust offers them (`live_controls`: macOS has all,
 * Windows the camera ones, Linux none since its pill is filmed): the
 * microphone button mutes and unmutes (silence goes into the file), its
 * menu switches to another microphone, and the camera's menu switches the
 * camera and, for a bubble, its size. A menu grows the pill's window
 * (`capture_controls_menu`), which is content protected like the pill, so
 * the menu is never in the video.
 *
 * Rust owns the session; this page only mirrors `capture_state_changed` and
 * invokes pause/resume/restart/stop/cancel. Content-protected by the window builder so
 * it stays out of the recording, and draggable by its body
 * (`data-tauri-drag-region`). The same dark glass as the capture bar; the
 * menu bar carries a second Stop (tray title).
 *
 * Where the pill is filmed with the screen (Linux has no content
 * protection, Rust's `compact`), it stays a small dot and time until it is
 * pointed at or focused, and the first time ever it says so (Rust's
 * `filmedNote`). The tray menu and the shortcut stop a recording there too.
 *
 * Escape does nothing here. The pill becomes the key window as soon as it is
 * clicked (Pause, say), so a stray Escape meant for another app landed here
 * and threw a recording away. Discarding is the trash button only, and past
 * a few seconds it asks first. Restart throws the take away too, so it asks
 * the same question.
 */

function isLive(phase: CapturePhase): phase is Extract<CapturePhase, { phase: "recording" | "paused" }> {
  return phase.phase === "recording" || phase.phase === "paused";
}

const PILL = `flex items-center rounded-full ${GLASS_PILL}`;
/** The pill's own row: the window's height when no menu is open (Rust's `CONTROLS_HEIGHT`). */
const PILL_ROW = "flex h-[60px] w-full shrink-0 items-center justify-center";
/** The small button beside the microphone and the camera that opens their menu. */
const MENU_BUTTON = `grid h-7 w-4 place-items-center rounded-full ${GLASS_BUTTON}`;
/** How long the one-time "filmed" line stays before the pill folds up. */
const NOTE_MS = 8000;
/** The grace before a pointed-at compact pill folds up again. */
const COLLAPSE_MS = 600;
const ICON_BUTTON = `grid size-7 place-items-center rounded-full ${GLASS_BUTTON}`;

/** What the pill is asking before it throws the recording away. */
type Question = "discard" | "restart";

const QUESTION: Record<Question, { title: string; body: string; confirm: string }> = {
  discard: { title: "Discard this recording?", body: "Nothing will be saved.", confirm: "Discard" },
  restart: { title: "Restart this recording?", body: "What you recorded is thrown away.", confirm: "Restart" },
};

export default function CaptureControlsPage() {
  const [phase, setPhase] = useState<CapturePhase>({ phase: "idle" });
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState<CaptureCameraState | null>(null);
  const [confirming, setConfirming] = useState<Question | null>(null);
  // A sound source that went away mid-recording, in Rust's words; the
  // recording goes on without it.
  const [lost, setLost] = useState<CaptureDeviceLost | null>(null);
  // The recording's microphone (muted, which device, what may change), Rust's.
  const [mic, setMic] = useState<CaptureMicrophoneState | null>(null);
  // The open menu, and whether the window grew above the pill for it.
  const [menu, setMenu] = useState<PillMenuKind | null>(null);
  const [menuAbove, setMenuAbove] = useState(true);
  const micMenuRef = useRef<HTMLButtonElement | null>(null);
  const cameraMenuRef = useRef<HTMLButtonElement | null>(null);
  // Seconds left before the recording begins, where it counts here (after
  // the desktop's own dialog on Wayland); null otherwise.
  const [countdown, setCountdown] = useState<number | null>(null);
  // Filmed here: small until pointed at or focused, and a one-time line.
  const [compact, setCompact] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const collapseTimer = useRef<number | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  // The button to give focus back to once the question is answered "keep".
  const focusBack = useRef<Question | null>(null);
  const trashRef = useRef<HTMLButtonElement | null>(null);
  const restartRef = useRef<HTMLButtonElement | null>(null);

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
    let heardMic = false;
    void getCaptureMicrophoneState()
      .then((m) => !heardMic && setMic(m))
      .catch(() => undefined);
    void getCaptureState()
      .then(take)
      .catch(() => undefined);
    void getCaptureCameraContext()
      .then((c) => !heardCamera && setCamera(c))
      .catch(() => undefined);
    void getCaptureControlsContext()
      .then((c) => {
        setCompact(c.compact);
        setNote(c.filmedNote);
      })
      .catch(() => undefined);
    const unlisteners = [
      listen<CapturePhaseEvent>("capture_state_changed", (e) => take(e.payload)),
      listen<CaptureCameraState>("capture_camera_state", (e) => {
        heardCamera = true;
        setCamera(e.payload);
      }),
      listen<CaptureDeviceLost>(DEVICE_LOST_EVENT, (e) => setLost(e.payload)),
      listen<CaptureMicrophoneState>(MICROPHONE_STATE_EVENT, (e) => {
        heardMic = true;
        setMic(e.payload);
      }),
      listen<number | null>(PILL_COUNTDOWN_EVENT, (e) => setCountdown(e.payload)),
    ];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, []);

  const live = isLive(phase);
  // The one-time line goes by itself after a while; "Got it" sooner.
  useEffect(() => {
    if (!note || !live) return;
    const timer = window.setTimeout(() => setNote(null), NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [note, live]);
  useEffect(
    () => () => {
      if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    },
    [],
  );
  const expand = () => {
    if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    collapseTimer.current = null;
    setExpanded(true);
  };
  // A short grace, so moving the pointer across a gap between buttons does
  // not fold the controls away under it.
  const collapseSoon = () => {
    if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    collapseTimer.current = window.setTimeout(() => setExpanded(false), COLLAPSE_MS);
  };
  // The question goes when the recording ends some other way (the tray's Stop).
  useEffect(() => {
    if (!live) {
      setConfirming(null);
      setLost(null);
    }
  }, [live]);

  // Rust grows the window before the menu is drawn in it, and shrinks it
  // back once it is gone; the pill itself stays where it is.
  const closeMenu = (refocus = false) => {
    const was = menu;
    setMenu(null);
    if (refocus) (was === "camera" ? cameraMenuRef : micMenuRef).current?.focus();
    void setCaptureControlsMenu(false).catch(() => undefined);
  };
  const openMenu = async (kind: PillMenuKind) => {
    if (menu === kind) return closeMenu();
    try {
      const placed = await setCaptureControlsMenu(true);
      setMenuAbove(placed.above);
      setMenu(kind);
    } catch {
      // No room was made: no menu.
    }
  };
  // A menu goes with the recording (stopped from the tray, saved), and when
  // the user turns to another app: the grown window must not sit over it.
  const menuOpen = menu !== null;
  useEffect(() => {
    if (!menuOpen) return;
    const shut = () => {
      setMenu(null);
      void setCaptureControlsMenu(false).catch(() => undefined);
    };
    if (!live) {
      shut();
      return;
    }
    window.addEventListener("blur", shut);
    return () => window.removeEventListener("blur", shut);
  }, [live, menuOpen]);

  // Asking: Escape and "Keep recording" both mean no, and focus starts on
  // no. Answered no, focus goes back to the button that asked (it is drawn
  // again only once the question is gone).
  useEffect(() => {
    if (!confirming) {
      const back = focusBack.current;
      focusBack.current = null;
      if (back) (back === "restart" ? restartRef : trashRef).current?.focus();
      return;
    }
    keepRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      focusBack.current = confirming;
      setConfirming(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming]);

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch {
      // Rust reports a failed stop or discard itself (card and notification).
    } finally {
      setBusy(false);
    }
  };

  const starting = phase.phase === "capturing" && phase.kind === "recording";
  if (starting && countdown !== null) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div data-tauri-drag-region className={`${PILL} gap-2 py-1.5 pl-3.5 pr-1.5`}>
          <span aria-hidden data-tauri-drag-region className="size-2.5 rounded-full bg-[#FF453A]" />
          <span data-tauri-drag-region role="timer" aria-live="assertive" className="whitespace-nowrap text-sm">
            Recording in <span className="font-mono tabular-nums">{countdown}</span>
          </span>
          <button
            type="button"
            onClick={() => void skipCaptureCountdown().catch(() => undefined)}
            className={`h-7 shrink-0 rounded-full bg-white/10 px-2.5 text-[11.5px] font-medium ${GLASS_BUTTON}`}
          >
            Start now
          </button>
          <button
            type="button"
            disabled={busy}
            aria-label="Cancel recording"
            title="Cancel (nothing is recorded)"
            className={ICON_BUTTON}
            onClick={() => void run(cancelCapture)}
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
    );
  }
  if (starting || phase.phase === "finalizing") {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div role="status" className={`${PILL} gap-3 px-4 py-2 text-sm`}>
          <span aria-hidden className="size-2 animate-pulse rounded-full bg-[#3167DD] motion-reduce:animate-none" />
          {starting ? "Starting recording…" : "Saving recording…"}
        </div>
      </div>
    );
  }

  if (!isLive(phase)) {
    return null;
  }

  if (confirming) {
    const question = QUESTION[confirming];
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div
          role="alertdialog"
          aria-labelledby="question-title"
          aria-describedby="question-body"
          className={`${PILL} max-w-full gap-1.5 py-1.5 pl-3 pr-1.5`}
        >
          {/* Sized for the pill's 380 pt window: the text column wraps before anything clips. */}
          <div className="min-w-0 flex-1 leading-tight">
            <p id="question-title" className="text-[11.5px] font-semibold">
              {question.title}
            </p>
            <p id="question-body" className="text-[11px] text-white/70">
              {question.body}
            </p>
          </div>
          <button
            ref={keepRef}
            type="button"
            onClick={() => {
              focusBack.current = confirming;
              setConfirming(null);
            }}
            className={`h-7 shrink-0 rounded-full bg-white/10 px-2 text-[11.5px] font-medium ${GLASS_BUTTON}`}
          >
            Keep recording
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setConfirming(null);
              void run(confirming === "restart" ? restartCapture : cancelCapture);
            }}
            className={`h-7 shrink-0 rounded-full bg-[#D70015] px-2.5 text-[11.5px] font-semibold text-white hover:bg-[#b80012] disabled:opacity-40 ${GLASS_FOCUS}`}
          >
            {question.confirm}
          </button>
        </div>
      </div>
    );
  }

  /** Throw the take away (discard, or restart on the same selection), asking first past a few seconds. */
  const throwAway = (question: Question) => {
    if (menu) closeMenu();
    if (discardNeedsConfirm(phase.elapsedSecs)) {
      setConfirming(question);
    } else {
      void run(question === "restart" ? restartCapture : cancelCapture);
    }
  };

  if (note) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div data-tauri-drag-region className={`${PILL} max-w-full gap-2 py-1.5 pl-3.5 pr-1.5`}>
          <span aria-hidden data-tauri-drag-region className="size-2.5 shrink-0 rounded-full bg-[#FF453A]" />
          <p role="status" data-tauri-drag-region className="min-w-0 flex-1 text-[11px] leading-tight text-white/80">
            {note}
          </p>
          <button
            type="button"
            onClick={() => setNote(null)}
            className={`h-7 shrink-0 rounded-full bg-white/10 px-2.5 text-[11.5px] font-medium ${GLASS_BUTTON}`}
          >
            Got it
          </button>
        </div>
      </div>
    );
  }

  const paused = phase.phase === "paused";
  const collapsed = compact && !expanded && !busy;
  // Only a bubble can be hidden: the camera-only stage IS the recording.
  // `shape` goes null while hidden, so a hidden bubble is still a bubble here.
  const hasBubble = camera?.shape === "bubble" || camera?.hidden === true;
  const bubbleShown = camera?.shape === "bubble" && !camera.hidden;
  // What Rust offers mid-recording; nothing is decided here.
  const micLost = lost?.device === "microphone";
  const canMute = phase.microphone && !micLost && !!mic?.canMute;
  const micMenu = phase.microphone && !micLost && !!mic?.canSwitch;
  const cameraMenu = !!camera && (camera.switchFromPill || camera.resizeFromPill);
  const Chevron = menuAbove ? ChevronUp : ChevronDown;
  const menuPanel = menu && (
    <PillMenu kind={menu} microphone={mic} camera={camera} onMicrophone={setMic} onClose={closeMenu} />
  );

  return (
    <div
      className={`flex h-full w-full flex-col ${menu && menuAbove ? "justify-end" : "justify-start"}`}
      // A click in the window's empty part, beside the menu, closes it.
      onPointerDown={(e) => {
        if (menu && e.target === e.currentTarget) closeMenu();
      }}
    >
      {menu && menuAbove && menuPanel}
      <div className={PILL_ROW}>
        <div
          data-tauri-drag-region
          role="group"
          aria-label="Recording controls"
          // Compact: the controls open on pointing or on focus (Tab reaches the
          // group itself while they are folded away).
          tabIndex={collapsed ? 0 : undefined}
          onPointerEnter={compact ? expand : undefined}
          onPointerLeave={compact ? collapseSoon : undefined}
          onFocus={compact ? expand : undefined}
          onBlur={
            compact
              ? (e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) collapseSoon();
                }
              : undefined
          }
          className={`${PILL} gap-2 py-1.5 ${collapsed ? "px-3" : "pl-3.5 pr-1.5"} ${GLASS_FOCUS}`}
        >
          <span
            aria-hidden
            data-tauri-drag-region
            className={`size-2.5 rounded-full ${
              paused ? "bg-amber-400" : "animate-pulse bg-[#FF453A] shadow-[0_0_0_3px_rgba(255,69,58,0.25)] motion-reduce:animate-none"
            }`}
          />
          <span
            data-tauri-drag-region
            className="min-w-[3.25rem] font-mono text-sm tabular-nums tracking-tight"
            role="timer"
            aria-label={`Recording time ${mmss(phase.elapsedSecs)}${paused ? ", paused" : ""}`}
          >
            {mmss(phase.elapsedSecs)}
          </span>
          {phase.microphone &&
            (micLost ? (
              <MicOff className="size-3.5 text-amber-400" role="img" aria-label={lost?.message}>
                <title>{lost?.message}</title>
              </MicOff>
            ) : canMute && !collapsed ? (
              <span className="flex items-center">
                <button
                  type="button"
                  disabled={busy}
                  aria-label={mic?.muted ? "Unmute microphone" : "Mute microphone"}
                  aria-pressed={!!mic?.muted}
                  title={mic?.muted ? "Unmute (the recording is silent while muted)" : "Mute (the recording carries on, silent)"}
                  className={ICON_BUTTON}
                  onClick={() => void run(() => muteCaptureMicrophone(!mic?.muted).then(setMic))}
                >
                  {mic?.muted ? <MicOff className="size-4 text-[#FF453A]" /> : <Mic className="size-4" />}
                </button>
                {micMenu && (
                  <button
                    ref={micMenuRef}
                    type="button"
                    disabled={busy}
                    aria-label="Choose a microphone"
                    aria-haspopup="menu"
                    aria-expanded={menu === "microphone"}
                    title="Choose a microphone"
                    className={MENU_BUTTON}
                    onClick={() => void openMenu("microphone")}
                  >
                    <Chevron className="size-3" />
                  </button>
                )}
              </span>
            ) : mic?.muted ? (
              <MicOff className="size-3.5 text-[#FF453A]" role="img" aria-label="Microphone muted" />
            ) : (
              <Mic className="size-3.5 text-white/60" role="img" aria-label="Recording the microphone" />
            ))}
          {lost && lost.device !== "microphone" && (
            <VolumeX className="size-3.5 text-amber-400" role="img" aria-label={lost.message}>
              <title>{lost.message}</title>
            </VolumeX>
          )}
          {/* Always mounted, so a screen reader hears the line when it arrives. */}
          <span role="status" className="sr-only">
            {lost?.message ?? ""}
          </span>

          {!collapsed && <div aria-hidden data-tauri-drag-region className="mx-1 h-4 w-px bg-white/15" />}

          <div hidden={collapsed} className={collapsed ? "hidden" : "flex items-center gap-1"}>
            {hasBubble && (
              <button
                type="button"
                disabled={busy}
                aria-label={bubbleShown ? "Hide camera" : "Show camera"}
                aria-pressed={bubbleShown}
                title={bubbleShown ? "Hide the camera (the recording carries on)" : "Show the camera again"}
                className={ICON_BUTTON}
                onClick={() => void run(toggleCaptureCamera)}
              >
                {bubbleShown ? <Video className="size-4" /> : <VideoOff className="size-4 text-white/60" />}
              </button>
            )}
            {cameraMenu && (
              <button
                ref={cameraMenuRef}
                type="button"
                disabled={busy}
                aria-label="Camera options"
                aria-haspopup="menu"
                aria-expanded={menu === "camera"}
                title="Camera and size"
                className={hasBubble ? MENU_BUTTON : ICON_BUTTON}
                onClick={() => void openMenu("camera")}
              >
                {hasBubble ? <Chevron className="size-3" /> : <Video className="size-4" />}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              aria-label={paused ? "Resume recording" : "Pause recording"}
              title={paused ? "Resume" : "Pause"}
              className={ICON_BUTTON}
              onClick={() => void run(paused ? resumeCapture : pauseCapture)}
            >
              {paused ? <Play className="size-4 fill-current" /> : <Pause className="size-4" />}
            </button>
            <button
              ref={restartRef}
              type="button"
              disabled={busy}
              aria-label="Restart recording"
              title="Restart (throws this take away)"
              className={ICON_BUTTON}
              onClick={() => throwAway("restart")}
            >
              <RotateCcw className="size-4" />
            </button>
            <button
              type="button"
              disabled={busy}
              aria-label="Stop recording"
              title="Stop and save"
              className={ICON_BUTTON}
              onClick={() => void run(stopCapture)}
            >
              <Square className="size-3.5 fill-current" />
            </button>
            <button
              ref={trashRef}
              type="button"
              disabled={busy}
              aria-label="Discard recording"
              title="Discard (nothing is saved)"
              className={ICON_BUTTON}
              onClick={() => throwAway("discard")}
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        </div>
      </div>
      {menu && !menuAbove && menuPanel}
    </div>
  );
}
