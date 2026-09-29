import type { CaptureKind, CaptureMode } from "@/app/lib/tauri/capture";

/**
 * What the capture bar shows, decided without React so it can be tested:
 * which mode buttons exist, what the button says, and the one-line hint.
 * Rust decides what a capture MEANS (`capture::bar`); this only words it.
 */

export interface BarMode {
  kind: CaptureKind;
  mode: CaptureMode;
  /** Accessible name and tooltip, macOS's own wording. */
  label: string;
}

const SHOTS: BarMode[] = [
  { kind: "screenshot", mode: "screen", label: "Capture entire screen" },
  { kind: "screenshot", mode: "window", label: "Capture selected window" },
  { kind: "screenshot", mode: "area", label: "Capture selected portion" },
];

const RECORDINGS: BarMode[] = [
  { kind: "recording", mode: "screen", label: "Record entire screen" },
  { kind: "recording", mode: "window", label: "Record selected window" },
  { kind: "recording", mode: "area", label: "Record selected portion" },
];

/** The bar's two groups; the recording group only where recording works. */
export function barGroups(recordingAvailable: boolean): BarMode[][] {
  return recordingAvailable ? [SHOTS, RECORDINGS] : [SHOTS];
}

/** "Capture" or "Record", on the bar's main button. */
export function confirmLabel(kind: CaptureKind): string {
  return kind === "recording" ? "Record" : "Capture";
}

/**
 * The line above the bar. `hasArea` is whether an area is drawn anywhere, and
 * `onThisDisplay` whether the pointer is on this display (a screen hint only
 * makes sense for the screen being pointed at).
 */
export function barHint(kind: CaptureKind, mode: CaptureMode, hasArea: boolean): string {
  const verb = kind === "recording" ? "record" : "capture";
  if (mode === "window") return `Click a window to ${verb} it`;
  if (mode === "screen") return `Click a screen to ${verb} it, or press Return`;
  return hasArea ? `Drag to adjust, then press Return to ${verb}` : `Drag to choose what to ${verb}`;
}

/** The timer choices the Options menu offers, as Rust accepts them. */
export const TIMER_OPTIONS: readonly { secs: number; label: string }[] = [
  { secs: 0, label: "None" },
  { secs: 5, label: "5 seconds" },
  { secs: 10, label: "10 seconds" },
];

/** Where remembered areas live: one area, on the display it was drawn on. */
export const LAST_AREA_KEY = "hippius:capture-last-area";
