import { AppWindow, Monitor, SquareDashed } from "lucide-react";
import type { CaptureKind, CaptureMode, RecordingAvailability } from "@/app/lib/tauri/capture";

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
 * `capture_support` / the overlay context (`modes`). Absent on a build whose
 * Rust does not report them yet, which offers every mode.
 */
export type SupportedModes = Partial<Record<CaptureKind, readonly CaptureMode[]>>;

/** `modes` from a `capture_support` or overlay-context answer, or null when Rust sent none. */
export function supportedModesOf(answer: object | null | undefined): SupportedModes | null {
  if (!answer || !("modes" in answer)) return null;
  const modes = (answer as { modes?: unknown }).modes;
  return modes && typeof modes === "object" ? (modes as SupportedModes) : null;
}

/**
 * The modes a menu offers for `kind`, in {@link MENU_MODES} order: those Rust
 * says this platform supports, or all three when it did not say.
 */
export function offeredModes(kind: CaptureKind, supported: SupportedModes | null): CaptureMode[] {
  const allowed = supported?.[kind];
  return allowed ? MENU_MODES.filter((m) => allowed.includes(m)) : [...MENU_MODES];
}

/**
 * The line to show beside disabled Record modes, or null to show them
 * normally (recording works) or not at all (no recorder on this platform).
 * Only a Mac that could record with another build or a newer macOS gets the
 * disabled modes: a missing helper must be visible, not a vanished feature.
 * The words are Rust's (`recordingUnavailableMessage`).
 */
export function disabledRecordingNote(availability: RecordingAvailability): string | null {
  const reason = availability.recordingUnavailable;
  if (reason !== "helperMissing" && reason !== "osTooOld") return null;
  return availability.recordingUnavailableMessage;
}
