import { atom } from "jotai";
import type { CaptureSurfaces } from "@/app/lib/tauri/capture";
import type { SupportedModes } from "./modes";
import { isRecordingLimitReached, isScreenRecordingPermissionMissing } from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";

/**
 * Which capture dialog is open, if any. One atom so every surface that can
 * start a capture — the Drive header, the tray, the shortcut — lands the user
 * in the same dialog, mounted once by `CaptureHost`.
 *
 * `captureDrive` is where captures go: set up on the first capture (Rust
 * asks, with the capture kept safe meanwhile) and moved from Settings, the
 * Captures page and the Capture menus.
 */
export type CaptureDialog = { kind: "captureDrive" } | { kind: "permission" } | { kind: "recordingLimit" };

export const captureDialogAtom = atom<CaptureDialog | null>(null);

/** Whether this build and platform can capture screenshots, from Rust. */
export const captureSupportedAtom = atom<boolean>(false);

/**
 * Whether Rust has answered `capture_support` yet (or failed to). Until it
 * has, `captureSupportedAtom` is a placeholder `false`, not a "no": a gate
 * that redirects or resets on "no" must wait for this (`useCaptureAvailability`).
 */
export const captureSupportKnownAtom = atom<boolean>(false);

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

/**
 * How this platform captures (Rust's `capture_support` surfaces): whether a
 * screenshot goes through Hippius's bar or the desktop's own tool, and
 * whether the shortcut works here. Null until Rust has answered.
 */
export const captureSurfacesAtom = atom<CaptureSurfaces | null>(null);

/** What System Settings calls the Screen Recording pane on this Mac (Rust's `permissionPane`); null until known. */
export const capturePermissionPaneAtom = atom<string | null>(null);

/** What `capture_start`'s refusal asks the UI to do next. */
export type CaptureRefusal =
  | { next: "grant-permission" }
  | { next: "recording-limit" }
  | { next: "show-error"; message: string };

/**
 * Sort a `capture_start` failure by what answers it. Matched on the structured
 * `subkind`, never the message: `NotReady` is silenced wholesale on several
 * generic error paths, so these must be picked out explicitly or they
 * vanish without a dialog.
 */
export function classifyCaptureRefusal(error: unknown): CaptureRefusal {
  if (isScreenRecordingPermissionMissing(error)) return { next: "grant-permission" };
  if (isRecordingLimitReached(error)) return { next: "recording-limit" };
  return { next: "show-error", message: errorMessage(error) };
}
