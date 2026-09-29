import { invoke } from "@tauri-apps/api/core";
import { isNotReady } from "@/app/lib/utils/dispatchTauriError";

/**
 * Screen capture IPCs. Every decision — whether a capture may start, where it
 * goes, what the notification says — is Rust's (`src-tauri/src/capture/`);
 * these wrappers only name the commands and their shapes.
 */

export type CaptureKind = "screenshot" | "recording";
export type CaptureMode = "area" | "window" | "screen";

/** Mirrors Rust's `CapturePhase`, as broadcast on `capture_state_changed`. */
export type CapturePhase =
  | { phase: "idle" }
  | { phase: "selecting"; kind: CaptureKind; mode: CaptureMode }
  | { phase: "capturing"; kind: CaptureKind }
  | { phase: "recording"; elapsedSecs: number; microphone: boolean }
  | { phase: "paused"; elapsedSecs: number; microphone: boolean }
  | { phase: "finalizing" }
  | { phase: "delivering"; kind: CaptureKind };

/** A selection rectangle in the overlay's own CSS pixels (logical points). */
export interface LogicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the overlay reports; mirrors Rust's `Selection`. */
export type CaptureSelection =
  | { target: "area"; displayId: number; rect: LogicalRect }
  | { target: "window"; windowId: number }
  | { target: "screen"; displayId: number };

/** A window the overlay can highlight, in its display's local CSS pixels. */
export interface CaptureWindowTarget extends LogicalRect {
  id: number;
  appName: string;
  title: string;
}

/** What the capture bar remembers, on this device. Mirrors Rust's `CaptureOptions`. */
export interface CaptureOptions {
  /** Screenshot timer: 0, 5 or 10 seconds. */
  timerSecs: number;
  microphone: boolean;
  /** Which microphone (the helper's id); null = the system default. */
  microphoneDevice: string | null;
  /** Record the screen. Off = camera only (Rust turns the camera on). */
  screen: boolean;
  /** Show the camera in recordings: a bubble, or the whole video when the screen is off. */
  camera: boolean;
  /** Which camera (the webview's `deviceId`); null = the default one. */
  cameraDevice: string | null;
  showClicks: boolean;
  lastKind: CaptureKind;
  lastMode: CaptureMode;
}

export interface CaptureOverlayContext {
  mode: CaptureMode;
  displayId: number;
  kind: CaptureKind;
  /** Front first; empty outside window mode. */
  windows: CaptureWindowTarget[];
  /** Whether this overlay draws the capture bar (one display does). */
  hostsBar: boolean;
  options: CaptureOptions;
  /** Seconds to count down once Capture / Record is pressed. */
  countdownSecs: number;
  recordingAvailable: boolean;
  microphoneAvailable: boolean;
  showClicksAvailable: boolean;
  destination: CaptureDestination | null;
  /** The area already drawn, on this display or another. */
  pending: CaptureSelection | null;
}

/** How the camera shows. Mirrors Rust's `CameraShape`. */
export type CameraShape = "bubble" | "stage";

/** `capture_camera_state`, for the camera window and the pill. Mirrors Rust's `camera::CameraState`. */
export interface CaptureCameraState {
  /** Null when no camera window is up. */
  shape: CameraShape | null;
  /** The bubble was hidden from the pill mid-recording. */
  hidden: boolean;
  deviceId: string | null;
}

/** A camera or microphone the bar's pickers offer. */
export interface CaptureDevice {
  id: string;
  name: string;
}

/** A drive "Save to" offers; `remote` means not synced on this machine. */
export interface CaptureDestinationChoice {
  label: string;
  remote: boolean;
}

/** Where a capture's upload is, on its preview card. Mirrors Rust's `PreviewStatus`. */
export type CapturePreviewStatus =
  | { state: "uploading" }
  /** In the synced folder; the sync engine is uploading it. */
  | { state: "syncing"; linkCopied: boolean; linkError?: string }
  | { state: "uploaded"; linkCopied: boolean; linkError?: string }
  | { state: "failed"; message: string };

/** The preview card in the corner. Mirrors Rust's `PreviewCard`. */
export interface CapturePreviewCard {
  id: number;
  kind: CaptureKind;
  fileName: string;
  driveLabel: string;
  driveName: string;
  remote: boolean;
  thumbnail?: string;
  status: CapturePreviewStatus;
}

/** `capture_show_in_folder`: open this drive's Captures folder. */
export interface CaptureShowInFolder {
  label: string;
  remote: boolean;
  subfolder: string;
  fileName: string;
}

export interface CaptureShortcutSetting {
  /** The active shortcut, or null when turned off. */
  accelerator: string | null;
  defaultAccelerator: string;
}

/** The drive captures are filed in. Owner + hash only for a shared drive. */
export interface CaptureDestination {
  label: string;
  displayName: string;
  ownerSs58?: string;
  folderHash?: string;
}

export interface CaptureDelivered {
  fileName: string;
  driveName: string;
  shareUrl: string | null;
  linkError?: string;
  /** Moved into a synced folder; the sync engine uploads it. */
  viaSync: boolean;
}

export interface CaptureSupport {
  supported: boolean;
  recording: boolean;
  screenRecordingPermission: boolean;
}

// Events (listened for by name at each call site, so the IPC contract test
// checks them against Rust): `capture_state_changed` → `CapturePhase`,
// `capture_delivered` → `CaptureDelivered`, `capture_failed` → `{ message }`,
// `capture_pending_changed` → `{ displayId: number | null }`,
// `capture_preview_changed` → `CapturePreviewCard | null`,
// `capture_show_in_folder` → `CaptureShowInFolder`,
// `capture_shortcut_pressed` → nothing,
// `capture_camera_state` → `CaptureCameraState`,
// `capture_cameras` → `CaptureDevice[]`.

/**
 * Open the capture bar. `kind` and `mode` preselect it (a menu item); left
 * out, it opens on what was used last.
 */
export function startCapture(kind?: CaptureKind, mode?: CaptureMode): Promise<void> {
  return invoke("capture_start", { kind: kind ?? null, mode: mode ?? null });
}

export function setCaptureMode(kind: CaptureKind, mode: CaptureMode): Promise<void> {
  return invoke("capture_set_mode", { kind, mode });
}

/** Hold (or clear) the area drawn on this display for the Capture button. */
export function setCapturePending(selection: CaptureSelection | null): Promise<void> {
  return invoke("capture_set_pending", { selection });
}

/** The capture bar's Capture / Record button, pressed on `displayId`. */
export function confirmCapture(displayId: number): Promise<void> {
  return invoke("capture_confirm", { displayId });
}

export function getCaptureOptions(): Promise<CaptureOptions> {
  return invoke("capture_get_options");
}

export function setCaptureOptions(options: CaptureOptions): Promise<CaptureOptions> {
  return invoke("capture_set_options", { options });
}

export function getCaptureDestinationChoices(): Promise<CaptureDestinationChoice[]> {
  return invoke("capture_destination_choices");
}

export function getCapturePreview(): Promise<CapturePreviewCard | null> {
  return invoke("capture_preview_context");
}

export function copyCapturePreviewLink(): Promise<void> {
  return invoke("capture_preview_copy_link");
}

export function showCapturePreviewInFolder(): Promise<void> {
  return invoke("capture_preview_show_in_folder");
}

export function dismissCapturePreview(id: number): Promise<void> {
  return invoke("capture_preview_dismiss", { id });
}

export function retryCapturePreview(): Promise<void> {
  return invoke("capture_preview_retry");
}

/** Register the saved system-wide shortcut (called when the app mounts). */
export function syncCaptureShortcut(): Promise<void> {
  return invoke("capture_sync_shortcut");
}

export function getCaptureShortcut(): Promise<CaptureShortcutSetting> {
  return invoke("capture_get_shortcut");
}

/** Change the shortcut; `null` turns it off. Refused if another app holds it. */
export function setCaptureShortcut(accelerator: string | null): Promise<void> {
  return invoke("capture_set_shortcut", { accelerator });
}

export function getCaptureCameraContext(): Promise<CaptureCameraState> {
  return invoke("capture_camera_context");
}

/** The camera window reports the cameras it can open, for the bar's picker. */
export function setCaptureCameras(cameras: CaptureDevice[]): Promise<void> {
  return invoke("capture_set_cameras", { cameras });
}

export function getCaptureCameras(): Promise<CaptureDevice[]> {
  return invoke("capture_cameras");
}

export function getCaptureMicrophones(): Promise<CaptureDevice[]> {
  return invoke("capture_microphones");
}

/** Hide or show the camera bubble mid-recording; resolves to whether it shows now. */
export function toggleCaptureCamera(): Promise<boolean> {
  return invoke("capture_camera_toggle");
}

export function getCaptureOverlayContext(displayId: number): Promise<CaptureOverlayContext> {
  return invoke("capture_overlay_context", { displayId });
}

export function selectCapture(selection: CaptureSelection): Promise<void> {
  return invoke("capture_select", { selection });
}

export function pauseCapture(): Promise<void> {
  return invoke("capture_pause");
}

export function resumeCapture(): Promise<void> {
  return invoke("capture_resume");
}

export function stopCapture(): Promise<void> {
  return invoke("capture_stop");
}

export function cancelCapture(): Promise<void> {
  return invoke("capture_cancel");
}

export function getCaptureState(): Promise<CapturePhase> {
  return invoke("capture_state");
}

export function getCaptureSupport(): Promise<CaptureSupport> {
  return invoke("capture_support");
}

export function openScreenRecordingSettings(): Promise<void> {
  return invoke("capture_open_permission_settings");
}

export function getCaptureDestination(): Promise<CaptureDestination | null> {
  return invoke("capture_get_destination");
}

export function setCaptureDestination(destination: CaptureDestination): Promise<void> {
  return invoke("capture_set_destination", { destination });
}

/** `capture_start` refused because no drive has been chosen yet. */
export function isCaptureDestinationUnset(error: unknown): boolean {
  return isNotReady(error, "CAPTURE_DESTINATION_UNSET");
}

/** `capture_start` refused because macOS has not granted Screen Recording. */
export function isScreenRecordingPermissionMissing(error: unknown): boolean {
  return isNotReady(error, "SCREEN_RECORDING_PERMISSION");
}
