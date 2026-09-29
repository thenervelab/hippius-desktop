"use client";

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Mic, Pause, Play, Square, Trash2, Video, VideoOff } from "lucide-react";
import "./capture-controls.css";
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

/**
 * Floating recording pill: time, microphone, camera, pause/resume, stop, discard.
 *
 * Rust owns the session; this page only mirrors `capture_state_changed` and
 * invokes pause/resume/stop/cancel. Content-protected by the window builder so
 * it stays out of the recording, and draggable by its body. The same dark
 * glass as the capture bar; the menu bar carries a second Stop (tray title).
 */

function formatElapsed(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function isLive(phase: CapturePhase): phase is Extract<CapturePhase, { phase: "recording" | "paused" }> {
  return phase.phase === "recording" || phase.phase === "paused";
}

export default function CaptureControlsPage() {
  const [phase, setPhase] = useState<CapturePhase>({ phase: "idle" });
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState<CaptureCameraState | null>(null);

  useEffect(() => {
    void getCaptureState().then(setPhase).catch(() => undefined);
    void getCaptureCameraContext().then(setCamera).catch(() => undefined);
    const unlisteners = [
      listen<CapturePhase>("capture_state_changed", (e) => setPhase(e.payload)),
      listen<CaptureCameraState>("capture_camera_state", (e) => setCamera(e.payload)),
    ];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void cancelCapture();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const starting = phase.phase === "capturing" && phase.kind === "recording";
  if (starting || phase.phase === "finalizing" || phase.phase === "delivering") {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="flex items-center gap-3 rounded-full border border-white/10 bg-[#1c1d21]/90 px-4 py-2 text-sm text-white shadow-lg backdrop-blur-xl">
          <span className="size-2 animate-pulse rounded-full bg-[#3167DD]" />
          {starting ? "Starting recording…" : phase.phase === "finalizing" ? "Saving recording…" : "Uploading…"}
        </div>
      </div>
    );
  }

  if (!isLive(phase)) {
    return null;
  }

  const paused = phase.phase === "paused";
  // Only a bubble can be hidden: the camera-only stage IS the recording.
  // `shape` goes null while hidden, so a hidden bubble is still a bubble here.
  const hasBubble = camera?.shape === "bubble" || camera?.hidden === true;
  const bubbleShown = camera?.shape === "bubble" && !camera.hidden;
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div
        className="flex items-center gap-2 rounded-full border border-white/10 bg-[#1c1d21]/90 py-1.5 pl-3.5 pr-1.5 text-white shadow-[0_10px_28px_rgba(0,0,0,0.45)] backdrop-blur-xl"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        title="Drag to move"
      >
        <span
          aria-hidden
          className={`size-2.5 rounded-full ${paused ? "bg-amber-400" : "animate-pulse bg-[#FF453A] shadow-[0_0_0_3px_rgba(255,69,58,0.25)]"}`}
        />
        <span className="min-w-[3.25rem] font-mono text-sm tabular-nums tracking-tight" aria-label="Recording time">
          {formatElapsed(phase.elapsedSecs)}
        </span>
        {phase.microphone && (
          <Mic className="size-3.5 text-white/60" aria-label="Recording the microphone" />
        )}

        <div className="mx-1 h-4 w-px bg-white/15" />

        <div className="flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          {hasBubble && (
            <button
              type="button"
              disabled={busy}
              aria-label={bubbleShown ? "Hide camera" : "Show camera"}
              aria-pressed={bubbleShown}
              title={bubbleShown ? "Hide the camera (the recording carries on)" : "Show the camera again"}
              className="rounded-full p-1.5 text-white/90 hover:bg-white/10 disabled:opacity-40"
              onClick={() => void run(() => toggleCaptureCamera().then(() => undefined))}
            >
              {bubbleShown ? <Video className="size-4" /> : <VideoOff className="size-4 text-white/60" />}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            aria-label={paused ? "Resume recording" : "Pause recording"}
            title={paused ? "Resume" : "Pause"}
            className="rounded-full p-1.5 text-white/90 hover:bg-white/10 disabled:opacity-40"
            onClick={() => void run(paused ? resumeCapture : pauseCapture)}
          >
            {paused ? <Play className="size-4 fill-current" /> : <Pause className="size-4" />}
          </button>
          <button
            type="button"
            disabled={busy}
            aria-label="Stop recording"
            title="Stop and save"
            className="rounded-full p-1.5 text-white/90 hover:bg-white/10 disabled:opacity-40"
            onClick={() => void run(stopCapture)}
          >
            <Square className="size-3.5 fill-current" />
          </button>
          <button
            type="button"
            disabled={busy}
            aria-label="Discard recording"
            title="Discard (nothing is saved)"
            className="rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-40"
            onClick={() => void run(cancelCapture)}
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
