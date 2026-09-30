"use client";

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Mic, Pause, Play, Square, Trash2, Video, VideoOff } from "lucide-react";
import "@/app/lib/capture/floating-window.css";
import {
  cancelCapture,
  getCaptureCameraContext,
  getCaptureState,
  pauseCapture,
  resumeCapture,
  stopCapture,
  toggleCaptureCamera,
  type CaptureCameraState,
  type CapturePhase,
} from "@/app/lib/tauri/capture";
import { GLASS_BAR, GLASS_BUTTON, GLASS_FOCUS } from "@/app/lib/capture/glass";
import { mmss } from "@/app/lib/capture/time";
import { discardNeedsConfirm } from "./discard";

/**
 * Floating recording pill: time, microphone, camera, pause/resume, stop, discard.
 *
 * Rust owns the session; this page only mirrors `capture_state_changed` and
 * invokes pause/resume/stop/cancel. Content-protected by the window builder so
 * it stays out of the recording, and draggable by its body
 * (`data-tauri-drag-region`). The same dark glass as the capture bar; the
 * menu bar carries a second Stop (tray title).
 *
 * Escape does nothing here. The pill becomes the key window as soon as it is
 * clicked (Pause, say), so a stray Escape meant for another app landed here
 * and threw a recording away. Discarding is the trash button only, and past
 * a few seconds it asks first.
 */

function isLive(phase: CapturePhase): phase is Extract<CapturePhase, { phase: "recording" | "paused" }> {
  return phase.phase === "recording" || phase.phase === "paused";
}

const PILL = `flex items-center rounded-full ${GLASS_BAR}`;
const ICON_BUTTON = `grid size-7 place-items-center rounded-full ${GLASS_BUTTON}`;

export default function CaptureControlsPage() {
  const [phase, setPhase] = useState<CapturePhase>({ phase: "idle" });
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState<CaptureCameraState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const trashRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // A first read that answers after an event would put an older phase back.
    let heardPhase = false;
    let heardCamera = false;
    void getCaptureState()
      .then((p) => !heardPhase && setPhase(p))
      .catch(() => undefined);
    void getCaptureCameraContext()
      .then((c) => !heardCamera && setCamera(c))
      .catch(() => undefined);
    const unlisteners = [
      listen<CapturePhase>("capture_state_changed", (e) => {
        heardPhase = true;
        setPhase(e.payload);
      }),
      listen<CaptureCameraState>("capture_camera_state", (e) => {
        heardCamera = true;
        setCamera(e.payload);
      }),
    ];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, []);

  const live = isLive(phase);
  // The question goes when the recording ends some other way (the tray's Stop).
  useEffect(() => {
    if (!live) setConfirming(false);
  }, [live]);

  // Asking: Escape and "Keep recording" both mean no, and focus starts on no.
  useEffect(() => {
    if (!confirming) return;
    keepRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setConfirming(false);
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
  if (starting || phase.phase === "finalizing" || phase.phase === "delivering") {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div role="status" className={`${PILL} gap-3 px-4 py-2 text-sm`}>
          <span aria-hidden className="size-2 animate-pulse rounded-full bg-[#3167DD] motion-reduce:animate-none" />
          {starting ? "Starting recording…" : phase.phase === "finalizing" ? "Saving recording…" : "Uploading…"}
        </div>
      </div>
    );
  }

  if (!isLive(phase)) {
    return null;
  }

  if (confirming) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div
          role="alertdialog"
          aria-labelledby="discard-title"
          aria-describedby="discard-body"
          className={`${PILL} max-w-full gap-1.5 py-1.5 pl-3 pr-1.5`}
        >
          {/* Sized for the pill's 340 pt window: the text column wraps before anything clips. */}
          <div className="min-w-0 flex-1 leading-tight">
            <p id="discard-title" className="text-[11.5px] font-semibold">
              Discard this recording?
            </p>
            <p id="discard-body" className="text-[11px] text-white/70">
              Nothing will be saved.
            </p>
          </div>
          <button
            ref={keepRef}
            type="button"
            onClick={() => {
              setConfirming(false);
              trashRef.current?.focus();
            }}
            className={`h-7 shrink-0 rounded-full bg-white/10 px-2 text-[11.5px] font-medium ${GLASS_BUTTON}`}
          >
            Keep recording
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(cancelCapture)}
            className={`h-7 shrink-0 rounded-full bg-[#D70015] px-2.5 text-[11.5px] font-semibold text-white hover:bg-[#b80012] disabled:opacity-40 ${GLASS_FOCUS}`}
          >
            Discard
          </button>
        </div>
      </div>
    );
  }

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
        {phase.microphone && <Mic className="size-3.5 text-white/60" role="img" aria-label="Recording the microphone" />}

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
            onClick={() => {
              if (discardNeedsConfirm(phase.elapsedSecs)) setConfirming(true);
              else void run(cancelCapture);
            }}
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
