import { useAtomValue } from "jotai";
import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";
import { captureSupportedAtom, captureSupportKnownAtom } from "./captureFlow";

/**
 * Whether screen capture is offered on this computer, in the main window.
 *
 * Two halves: the build carries capture (`SCREEN_CAPTURE_ENABLED`) and Rust
 * says this platform has it on this lane (`capture_support`, which reads
 * `capture::rollout`; set by `CaptureHost`). Production ships capture to
 * macOS only, so the flag alone would show Windows and Linux users capture
 * entries that do nothing.
 *
 * - `unknown`: Rust has not answered yet. Hide capture UI, but do not
 *   redirect or reset away from it: on a computer that captures, the answer
 *   is a moment away.
 * - `available` / `unavailable`: Rust's answer (a failed ask is
 *   `unavailable`).
 */
export type CaptureAvailability = "unknown" | "available" | "unavailable";

export function captureAvailability(enabled: boolean, known: boolean, supported: boolean): CaptureAvailability {
  if (!enabled) return "unavailable";
  if (!known) return "unknown";
  return supported ? "available" : "unavailable";
}

export function useCaptureAvailability(): CaptureAvailability {
  const known = useAtomValue(captureSupportKnownAtom);
  const supported = useAtomValue(captureSupportedAtom);
  return captureAvailability(SCREEN_CAPTURE_ENABLED, known, supported);
}
