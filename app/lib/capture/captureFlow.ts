import { atom } from "jotai";
import type { CaptureKind, CaptureMode } from "@/app/lib/tauri/capture";
import type { SupportedModes } from "./modes";
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
 * The destination dialog carries the capture it interrupted (`resume`), so
 * choosing a drive carries straight on into it instead of making the user
 * start over. `kind` and `mode` are left out when the bar was opening on
 * whatever was used last; `resume` is null when the dialog was opened only to
 * change the drive.
 */
export interface CaptureResume {
  kind?: CaptureKind;
  mode?: CaptureMode;
}

export type CaptureDialog =
  | { kind: "destination"; resume: CaptureResume | null }
  | { kind: "permission" };

export const captureDialogAtom = atom<CaptureDialog | null>(null);

/** Whether this build and platform can capture screenshots, from Rust. */
export const captureSupportedAtom = atom<boolean>(false);

/** Whether Record actions should be offered (macOS helper present). */
export const captureRecordingAtom = atom<boolean>(false);

/**
 * Why Record is shown disabled (Rust's line), when this Mac could record with
 * another build or a newer macOS; null when recording works or is not offered
 * on this platform at all (`disabledRecordingNote`).
 */
export const captureRecordingNoteAtom = atom<string | null>(null);

/**
 * The modes each kind may offer on this platform (`capture_support.modes`);
 * null when Rust does not say, which offers every mode (`offeredModes`).
 */
export const captureModesAtom = atom<SupportedModes | null>(null);

/** What System Settings calls the Screen Recording pane on this Mac (Rust's `permissionPane`); null until known. */
export const capturePermissionPaneAtom = atom<string | null>(null);

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
