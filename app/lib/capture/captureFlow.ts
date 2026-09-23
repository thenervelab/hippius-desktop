import { atom } from "jotai";
import type { CaptureKind, CaptureMode } from "@/app/lib/tauri/capture";
import {
  isCaptureDestinationUnset,
  isScreenRecordingPermissionMissing,
} from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";

/**
 * Which capture dialog is open, if any. One atom so every surface that can
 * start a capture — the Drive header, the tray, the shortcut — lands the user
 * in the same dialog, mounted once by `CaptureHost`.
 *
 * The destination dialog carries the kind+mode it interrupted, so choosing a
 * drive carries straight on into that capture instead of making the user start
 * over.
 */
export type CaptureDialog =
  | { kind: "destination"; resumeKind: CaptureKind | null; resumeMode: CaptureMode | null }
  | { kind: "permission" };

export const captureDialogAtom = atom<CaptureDialog | null>(null);

/** Whether this build and platform can capture screenshots, from Rust. */
export const captureSupportedAtom = atom<boolean>(false);

/** Whether Record actions should be offered (macOS helper present). */
export const captureRecordingAtom = atom<boolean>(false);

/** What `capture_start`'s refusal asks the UI to do next. */
export type CaptureRefusal =
  | { next: "choose-destination" }
  | { next: "grant-permission" }
  | { next: "show-error"; message: string };

/**
 * Sort a `capture_start` failure by what answers it. Matched on the structured
 * `subkind`, never the message: `NotReady` is silenced wholesale on several
 * generic error paths, so these two must be picked out explicitly or they
 * vanish without a dialog.
 */
export function classifyCaptureRefusal(error: unknown): CaptureRefusal {
  if (isCaptureDestinationUnset(error)) return { next: "choose-destination" };
  if (isScreenRecordingPermissionMissing(error)) return { next: "grant-permission" };
  return { next: "show-error", message: errorMessage(error) };
}
