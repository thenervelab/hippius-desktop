"use client";

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Mic, MicOff, Pause, Play, RotateCcw, Square, Trash2, Video, VideoOff, VolumeX } from "lucide-react";
import "@/app/lib/capture/floating-window.css";
import {
  DEVICE_LOST_EVENT,
  cancelCapture,
  getCaptureCameraContext,
  getCaptureState,
  pauseCapture,
  restartCapture,
  resumeCapture,
  stopCapture,
  toggleCaptureCamera,
  type CaptureCameraState,
  type CaptureDeviceLost,
  type CapturePhase,
  type CapturePhaseEvent,
} from "@/app/lib/tauri/capture";
import { GLASS_BAR, GLASS_BUTTON, GLASS_FOCUS } from "@/app/lib/capture/glass";
import { mmss } from "@/app/lib/capture/time";
import { discardNeedsConfirm } from "./discard";

/**
 * Floating recording pill: time, microphone, camera, pause/resume, restart,
 * stop, discard.
 *
 * Rust owns the session; this page only mirrors `capture_state_changed` and
 * invokes pause/resume/restart/stop/cancel. Content-protected by the window builder so
 * it stays out of the recording, and draggable by its body
 * (`data-tauri-drag-region`). The same dark glass as the capture bar; the
 * menu bar carries a second Stop (tray title).
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

const PILL = `flex items-center rounded-full ${GLASS_BAR}`;
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
    void getCaptureState()
      .then(take)
      .catch(() => undefined);
    void getCaptureCameraContext()
      .then((c) => !heardCamera && setCamera(c))
      .catch(() => undefined);
    const unlisteners = [
      listen<CapturePhaseEvent>("capture_state_changed", (e) => take(e.payload)),
      listen<CaptureCameraState>("capture_camera_state", (e) => {
        heardCamera = true;
        setCamera(e.payload);
      }),
      listen<CaptureDeviceLost>(DEVICE_LOST_EVENT, (e) => setLost(e.payload)),
    ];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, []);

  const live = isLive(phase);
  // The question goes when the recording ends some other way (the tray's Stop).
  useEffect(() => {
    if (!live) {
      setConfirming(null);
      setLost(null);
    }
  }, [live]);

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
          {/* Sized for the pill's 340 pt window: the text column wraps before anything clips. */}
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
    if (discardNeedsConfirm(phase.elapsedSecs)) {
      setConfirming(question);
    } else {
      void run(question === "restart" ? restartCapture : cancelCapture);
    }
  };

  const paused = phase.phase === "paused";
  // Only a bubble can be hidden: the camera-only stage IS the recording.
  // `shape` goes null while hidden, so a hidden bubble is still a bubble here.
  const hasBubble = camera?.shape === "bubble" || camera?.hidden === true;
  const bubbleShown = camera?.shape === "bubble" && !camera.hidden;

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div data-tauri-drag-region className={`${PILL} gap-2 py-1.5 pl-3.5 pr-1.5`}>
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
          (lost?.device === "microphone" ? (
            <MicOff className="size-3.5 text-amber-400" role="img" aria-label={lost.message}>
              <title>{lost.message}</title>
            </MicOff>
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

        <div aria-hidden data-tauri-drag-region className="mx-1 h-4 w-px bg-white/15" />

        <div className="flex items-center gap-1">
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
  );
}
