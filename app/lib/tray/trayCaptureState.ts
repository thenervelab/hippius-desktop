import type { CapturePhase } from "@/app/lib/tauri/capture";

/**
 * The menu bar's part in a recording, as macOS's own recording does it: the
 * elapsed time beside the Hippius icon, and a click on the icon stops.
 * Pure, so the tray watcher stays a thin shell.
 */

function clock(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** The text beside the tray icon, or `null` to show none (no recording). */
export function recordingTrayTitle(phase: CapturePhase): string | null {
  if (phase.phase === "recording") return `◼ ${clock(phase.elapsedSecs)}`;
  if (phase.phase === "paused") return `❚❚ ${clock(phase.elapsedSecs)}`;
  return null;
}

/** A click on the tray icon stops a running (or paused) recording. */
export function trayClickStopsRecording(phase: CapturePhase): boolean {
  return phase.phase === "recording" || phase.phase === "paused";
}
