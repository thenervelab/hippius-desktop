import type { CaptureKind, CaptureMode } from "@/app/lib/tauri/capture";
import { offeredModes, type SupportedModes } from "@/app/lib/capture/modes";

/**
 * Window and entire-screen modes work like macOS's click-to-capture (⌘⇧4
 * then Space): the pointer becomes a camera, the window or display under it
 * lights up, and one click takes it. This module only decides what the
 * overlay draws and which mode Space switches to; what a click selects is
 * still Rust's (`capture_select`, `capture_confirm`).
 */

/**
 * Where the pointer's point is inside the 32 x 32 cursor image: the middle
 * of the lens, so the window under the lens is the one that is taken.
 */
export const CURSOR_HOTSPOT = { x: 16, y: 17 } as const;

// The camera body macOS draws in its own click-to-capture: white with a dark
// outline, readable on any window. Drawn as vector art, so WebKit renders it
// at the display's scale.
const BODY =
  "<path d='M11.2 8h9.6l1.8 3H27a2.2 2.2 0 0 1 2.2 2.2v11.6A2.2 2.2 0 0 1 27 27H5a2.2 2.2 0 0 1-2.2-2.2V13.2A2.2 2.2 0 0 1 5 11h4.4z' fill='white' stroke='black' stroke-width='1.4' stroke-linejoin='round'/>";

const LENS: Record<CaptureKind, string> = {
  screenshot: "<circle cx='16' cy='17' r='4.6' fill='white' stroke='black' stroke-width='1.4'/>",
  // Record: the lens is the red record dot, the glyph Record has everywhere.
  recording:
    "<circle cx='16' cy='17' r='5' fill='white' stroke='black' stroke-width='1.4'/><circle cx='16' cy='17' r='3.2' fill='%23FF453A'/>",
};

/** The camera cursor's SVG, as a data URL. `#` is written `%23`, the one character a data URL cannot carry raw. */
export function cursorImage(kind: CaptureKind): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>${BODY}${LENS[kind]}</svg>`;
  return `data:image/svg+xml;utf8,${svg.replace(/</g, "%3C").replace(/>/g, "%3E")}`;
}

/**
 * The CSS `cursor` for click-to-capture: the camera (a record-dot camera for
 * recordings), falling back to the hand where a custom cursor cannot load.
 */
export function captureCursor(kind: CaptureKind): string {
  return `url("${cursorImage(kind)}") ${CURSOR_HOTSPOT.x} ${CURSOR_HOTSPOT.y}, pointer`;
}

/** Whether `mode` is chosen by a single click on what is under the pointer. */
export function isClickToCapture(mode: CaptureMode | "none"): mode is "window" | "screen" {
  return mode === "window" || mode === "screen";
}

/**
 * The mode Space switches to, as on macOS: window and area swap, and only to
 * a mode this platform offers for `kind`. Null when Space does nothing
 * (entire screen, or the other mode is not offered).
 */
export function spaceToggleMode(
  mode: CaptureMode,
  kind: CaptureKind,
  supported: SupportedModes | null,
): CaptureMode | null {
  const next: CaptureMode | null = mode === "window" ? "area" : mode === "area" ? "window" : null;
  if (next === null) return null;
  return offeredModes(kind, supported).includes(next) ? next : null;
}
