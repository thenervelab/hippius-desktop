import { AppWindow, Monitor, SquareDashed } from "lucide-react";
import type { CaptureKind, CaptureMode, CaptureSurfaces, RecordingAvailability } from "@/app/lib/tauri/capture";

/**
 * One vocabulary for the capture modes, on every surface that names them
 * (the bar, the Drive Capture menu, the share picker): "area", "window" and
 * "entire screen", in sentence case, each with one icon.
 */

export const MODE_ICON: Record<CaptureMode, typeof Monitor> = {
  area: SquareDashed,
  window: AppWindow,
  screen: Monitor,
};

const OBJECT: Record<CaptureMode, string> = {
  area: "an area",
  window: "a window",
  screen: "entire screen",
};

/** "Capture an area", "Record entire screen": a mode's name as an action. */
export function modeLabel(kind: CaptureKind, mode: CaptureMode): string {
  return `${kind === "recording" ? "Record" : "Capture"} ${OBJECT[mode]}`;
}

/** The order the Capture menu lists modes in (the bar keeps macOS's order). */
export const MENU_MODES: readonly CaptureMode[] = ["area", "window", "screen"];

/**
 * The modes each kind may offer on this platform, as Rust reports them in
 * `capture_support` / the overlay context (`modes`, from `support::Surfaces`).
 */
export type SupportedModes = Partial<Record<CaptureKind, readonly CaptureMode[]>>;

/** `modes` from a `capture_support` or overlay-context answer; null before one has arrived. */
export function supportedModesOf(answer: Partial<Pick<CaptureSurfaces, "modes">> | null | undefined): SupportedModes | null {
  return answer?.modes ?? null;
}

/**
 * The modes a menu offers for `kind`, in {@link MENU_MODES} order: those Rust
 * says this platform supports, or all three before its answer has arrived.
 */
export function offeredModes(kind: CaptureKind, supported: SupportedModes | null): CaptureMode[] {
  const allowed = supported?.[kind];
  return allowed ? MENU_MODES.filter((m) => allowed.includes(m)) : [...MENU_MODES];
}

/**
 * The line to show beside disabled Record modes, or null to show them
 * normally (recording works) or not at all (no recorder on this platform).
 * Every reason but `unsupportedPlatform` gets the disabled modes (a missing
 * helper, an old OS, a missing codec or portal): something the user or
 * another build can fix must be visible, not a vanished feature. The words
 * are Rust's (`recordingUnavailableMessage`).
 */
export function disabledRecordingNote(availability: RecordingAvailability): string | null {
  const reason = availability.recordingUnavailable;
  if (reason === null || reason === "unsupportedPlatform") return null;
  return availability.recordingUnavailableMessage;
}
