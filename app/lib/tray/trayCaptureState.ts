import type { CapturePhase } from "@/app/lib/tauri/capture";
import { mmss } from "@/app/lib/capture/time";

/**
 * The menu bar's part in a recording, as macOS's own recording does it: the
 * elapsed time beside the Hippius icon, and a click on the icon stops.
 * Pure, so the tray watcher stays a thin shell.
 */

/** The text beside the tray icon, or `null` to show none (no recording). */
export function recordingTrayTitle(phase: CapturePhase): string | null {
  if (phase.phase === "recording") return `◼ ${mmss(phase.elapsedSecs)}`;
  if (phase.phase === "paused") return `❚❚ ${mmss(phase.elapsedSecs)}`;
  return null;
}

/** A click on the tray icon stops a running (or paused) recording. */
export function trayClickStopsRecording(phase: CapturePhase): boolean {
  return phase.phase === "recording" || phase.phase === "paused";
}

/**
 * The tray title's writer: one write at a time, newest wins. `setTitle` is
 * async and two calls in quick succession (pause, then stop) finished out of
 * order, so an older "❚❚ 00:10" landed last and stayed beside the icon after
 * the recording was saved. A queued write that a newer title has replaced is
 * skipped; a title equal to the one shown is not written again.
 */
export function createTrayTitleQueue(
  write: (title: string | null) => Promise<void>,
  onError: (error: unknown) => void,
): (title: string | null) => Promise<void> {
  let wanted: string | null = null;
  let queue: Promise<void> = Promise.resolve();
  return (title) => {
    if (title === wanted) return queue;
    wanted = title;
    queue = queue
      .then(async () => {
        if (title !== wanted) return; // superseded while queued
        await write(title);
      })
      .catch(onError);
    return queue;
  };
}

/**
 * Follow the session's phase from its current value on: listen first, then
 * read the phase once to start from (a reload mid-recording). The read is
 * dropped when an event arrived while it was in flight, because the event
 * is newer, and applying the older read last would put a stale title back.
 */
export async function followCapturePhase(
  listenPhase: (onPhase: (phase: CapturePhase) => void) => Promise<unknown>,
  readPhase: () => Promise<CapturePhase>,
  onPhase: (phase: CapturePhase) => void,
): Promise<void> {
  let heard = false;
  await listenPhase((phase) => {
    heard = true;
    onPhase(phase);
  });
  const seed = await readPhase().catch(() => undefined);
  if (seed && !heard) onPhase(seed);
}
