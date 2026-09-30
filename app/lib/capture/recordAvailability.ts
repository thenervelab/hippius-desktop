"use client";

import { useAtomValue } from "jotai";
import { captureRecordingAtom, captureRecordingNoteAtom } from "./captureFlow";
import { isMacPlatform } from "./shortcutLabel";

/**
 * Whether the Record button is offered, and in what state.
 *
 * - `hidden`: recording does not exist on this platform (Windows and Linux
 *   today), so a Record button would only ever say no.
 * - `disabled`: it exists here but not in this build or on this Mac (the
 *   recording helper is missing), so the button stays, dimmed, and says why.
 * - `available`: pressing it opens the capture bar on recording.
 */
export type RecordAvailability =
  | { state: "available" }
  | { state: "hidden" }
  | { state: "disabled"; reason: string };

export const RECORDING_UNAVAILABLE_REASON = "Screen recording isn't available in this build.";

/**
 * The one place the Record state is decided. It reads `capture_support`'s
 * `recording` flag today; a richer "why not" from Rust plugs in here and
 * every surface follows.
 */
export function recordAvailability(
  support: { recording: boolean },
  mac: boolean,
  note: string | null = null,
): RecordAvailability {
  if (support.recording) return { state: "available" };
  // Rust's own line (`recordingUnavailableMessage`) when a Mac could record
  // with another build or a newer macOS; the generic one only as a fallback.
  if (note) return { state: "disabled", reason: note };
  if (!mac) return { state: "hidden" };
  return { state: "disabled", reason: RECORDING_UNAVAILABLE_REASON };
}

/** `recordAvailability` for this machine, from the support CaptureHost asked for. */
export function useRecordAvailability(): RecordAvailability {
  const recording = useAtomValue(captureRecordingAtom);
  const note = useAtomValue(captureRecordingNoteAtom);
  return recordAvailability({ recording }, isMacPlatform(), note);
}
