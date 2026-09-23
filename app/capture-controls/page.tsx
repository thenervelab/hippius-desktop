"use client";

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Circle, Pause, Play, Square, X } from "lucide-react";
import "./capture-controls.css";
import {
  cancelCapture,
  getCaptureState,
  pauseCapture,
  resumeCapture,
  stopCapture,
  type CapturePhase,
} from "@/app/lib/tauri/capture";

/**
 * Floating recording control bar: timer, pause/resume, stop, cancel.
 *
 * Rust owns the session; this page only mirrors `capture_state_changed` and
 * invokes pause/resume/stop/cancel. Content-protected by the window builder so
 * it stays out of the recording.
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

  useEffect(() => {
    void getCaptureState().then(setPhase).catch(() => undefined);
    const unlisten = listen<CapturePhase>("capture_state_changed", (e) => {
      setPhase(e.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void cancelCapture();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (phase.phase === "finalizing" || phase.phase === "delivering") {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="flex items-center gap-3 rounded-full bg-black/85 px-4 py-2 text-sm text-white shadow-lg">
          <span className="size-2 animate-pulse rounded-full bg-[#3167DD]" />
          {phase.phase === "finalizing" ? "Saving recording…" : "Uploading…"}
        </div>
      </div>
    );
  }

  if (!isLive(phase)) {
    return null;
  }

  const paused = phase.phase === "paused";
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
        className="flex items-center gap-2 rounded-full border border-white/10 bg-black/85 px-3 py-1.5 text-white shadow-lg"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <Circle className={`size-2.5 ${paused ? "fill-amber-400 text-amber-400" : "fill-red-500 text-red-500"}`} />
        <span className="min-w-[3.25rem] font-mono text-sm tabular-nums tracking-tight">
          {formatElapsed(phase.elapsedSecs)}
        </span>
        {phase.microphone && <span className="text-[11px] text-white/50">Mic</span>}

        <div className="mx-1 h-4 w-px bg-white/15" />

        <div className="flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
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
            aria-label="Cancel recording"
            title="Cancel"
            className="rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-40"
            onClick={() => void run(cancelCapture)}
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
