import type { CaptureWindowTarget } from "@/app/lib/tauri/capture";

/**
 * How often window mode asks Rust for this display's windows again, so a
 * window that moved, opened or closed while the bar is up highlights where
 * it now is.
 */
export const WINDOW_REFRESH_MS = 700;

/**
 * Poll `refresh` every `WINDOW_REFRESH_MS` while the page is visible, and
 * not at all while it is hidden (another Space, a closed lid). One request
 * at a time: a slow answer is never overtaken by the next. Returns the stop
 * function; nothing is delivered after it runs.
 */
export function pollWindows(
  refresh: () => Promise<CaptureWindowTarget[]>,
  onWindows: (windows: CaptureWindowTarget[]) => void,
  doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;

  const schedule = () => {
    if (stopped || timer !== null || doc.visibilityState !== "visible") return;
    timer = setTimeout(tick, WINDOW_REFRESH_MS);
  };

  function tick() {
    timer = null;
    if (stopped || doc.visibilityState !== "visible" || inFlight) return;
    inFlight = true;
    refresh()
      .then((windows) => {
        if (!stopped) onWindows(windows);
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        schedule();
      });
  }

  const onVisibility = () => {
    if (doc.visibilityState === "visible") schedule();
    else if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  doc.addEventListener("visibilitychange", onVisibility);
  schedule();

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
