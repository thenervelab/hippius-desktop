import { invoke } from "@tauri-apps/api/core";
import { isNotReady } from "@/app/lib/utils/dispatchTauriError";

/**
 * Screen capture IPCs. Every decision — whether a capture may start, where it
 * goes, what the notification says — is Rust's (`src-tauri/src/capture/`);
 * these wrappers only name the commands and their shapes.
 */

export type CaptureKind = "screenshot" | "recording";
export type CaptureMode = "area" | "window" | "screen";

/**
 * Mirrors Rust's `CapturePhase`. The session ends when the file exists (the
 * preview card owns the upload), so a new capture can start while the last
 * one uploads.
 */
export type CapturePhase =
  | { phase: "idle" }
  | { phase: "selecting"; kind: CaptureKind; mode: CaptureMode }
  | { phase: "capturing"; kind: CaptureKind }
  | { phase: "recording"; elapsedSecs: number; microphone: boolean }
  | { phase: "paused"; elapsedSecs: number; microphone: boolean }
  | { phase: "finalizing" };

/**
 * `capture_state_changed` and `capture_state`: the phase plus `seq`, a number
 * that only goes up. A surface seeded from `capture_state` drops any event
 * whose `seq` is not newer than what it holds. Mirrors Rust's `PhaseEvent`.
 */
export type CapturePhaseEvent = CapturePhase & { seq: number };

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
  /** Which camera (a system id, or an older build's webview `deviceId`); null = the default one. */
  cameraDevice: string | null;
  /** How big the camera bubble is. */
  cameraSize: CameraSize;
  showClicks: boolean;
  /** Record what the computer plays, mixed with the microphone (default off: speakers would echo the voice). */
  systemAudio: boolean;
  /** Rust keeps these from `capture_start` / `capture_set_mode`; the bar's copy is ignored on save. */
  lastKind: CaptureKind;
  lastMode: CaptureMode;
  /** Mint a public link after upload and copy it (default true). Off = filed only; the card can still make one. */
  copyLink: boolean;
  /** Recording countdown: 0, 3 or 5 seconds (default 3; anything else reads as 3). */
  recordCountdownSecs: number;
}

/** `capture_set_options` (via `saveCaptureOptions`). Mirrors Rust's `SavedOptions`. */
export interface CaptureSavedOptions {
  /** What Rust stored (timers snapped, camera only turned back into screen where unsupported). */
  options: CaptureOptions;
  /** Seconds to count down for the capture being chosen now. */
  countdownSecs: number;
  /** Whether the camera, if on, is in the video for the mode chosen now. */
  cameraFilmed: boolean;
}

/** How what to capture is chosen: Hippius's overlay, or the desktop's own picker (Wayland). Mirrors Rust's `SelectionUi`. */
export type CaptureSelectionUi = "overlay" | "systemPicker";

/** How the capture shortcut is registered on this platform. Mirrors Rust's `ShortcutVia`. */
export type CaptureShortcutVia = "plugin" | "portal" | "desktopSettings";

/**
 * What this platform's capture surfaces may offer (Rust's `support::Surfaces`),
 * flattened into `capture_support` and the overlay context. Rust decides; the
 * frontend never checks the platform.
 */
export interface CaptureSurfaces {
  selection: CaptureSelectionUi;
  /** The modes each kind may offer; Record's are also subject to `recordingUnavailable`. */
  modes: { screenshot: CaptureMode[]; recording: CaptureMode[] };
  /** Whether the screenshot timer is offered. */
  screenshotTimer: boolean;
  /** Whether a recording can carry the system's sound (the user still turns it on in `CaptureOptions.systemAudio`). */
  systemAudio: boolean;
  /** Rust's line for why the microphone cannot be recorded; null when it can. */
  microphoneUnavailableMessage: string | null;
  /** What to check when an iPhone is not in the camera or microphone menu (macOS); null elsewhere. */
  continuityHint: string | null;
  /** `unavailableMessage`: where there is no shortcut yet, Rust's line for what to use instead. */
  shortcut: { supported: boolean; via: CaptureShortcutVia; unavailableMessage: string | null };
  /** With the system picker, Rust's line saying the desktop's own tool chooses what is captured. */
  systemPickerNote: string | null;
  /** Which Linux session this is; null off Linux. */
  linuxSession: "x11" | "wayland" | null;
}

export interface CaptureOverlayContext extends RecordingAvailability, CaptureSurfaces {
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
  /** Camera only (screen off) can be recorded here (macOS with recording). */
  cameraOnlyAvailable: boolean;
  /** Whether the camera, if on, is in the video: false for a bubble over a window recording. */
  cameraFilmed: boolean;
  destination: CaptureDestination | null;
  /** The area already drawn, on this display or another; at start, the last area drawn on the bar's display. */
  pending: CaptureSelection | null;
}

/** `capture_pending_changed`. `rect` is the held area (null when cleared), so every overlay mirrors Rust. */
export interface CapturePendingChanged {
  displayId: number | null;
  rect: LogicalRect | null;
}

/** How the camera shows. Mirrors Rust's `CameraShape`. */
export type CameraShape = "bubble" | "stage";

/** The bubble's size. Mirrors Rust's `CameraSize`; "full" is the stage's frame, filmed with the screen. */
export type CameraSize = "small" | "large" | "full";

/** `capture_camera_state`, for the camera window and the pill. Mirrors Rust's `camera::CameraState`. */
export interface CaptureCameraState {
  /** Null when no camera window is up. */
  shape: CameraShape | null;
  /** The bubble was hidden from the pill mid-recording. */
  hidden: boolean;
  deviceId: string | null;
  /** The chosen camera's name: how the webview finds a system-listed camera. */
  deviceName: string | null;
  size: CameraSize;
  /** A recording is starting or running: the page hides its size strip (it would be filmed). */
  recording: boolean;
  /** Whether the camera is in the video (false for a bubble over a window recording). */
  cameraFilmed: boolean;
}

/** A camera or microphone the bar's pickers offer. Mirrors Rust's `recording::MediaDevice`. */
export interface CaptureDevice {
  id: string;
  name: string;
  /** The system's default device of its kind (listed first). */
  isDefault?: boolean;
  /** An iPhone's camera or microphone, reached through Continuity. */
  continuity?: boolean;
}

/** The share picker's tabs. Mirrors Rust's `share::ShareTab`. */
export type ShareTab = "window" | "screen";

/** A window the share picker offers. Mirrors Rust's `share::ShareWindow`. */
export interface ShareWindow {
  id: number;
  appName: string;
  title: string;
  displayId: number;
  /** On-screen size in points, for the tile's shape before its picture arrives. */
  width: number;
  height: number;
  thumbnail: string | null;
  icon: string | null;
}

/** A display the share picker offers. Mirrors Rust's `share::ShareDisplay`. */
export interface ShareDisplay {
  id: number;
  name: string;
  isPrimary: boolean;
  width: number;
  height: number;
  thumbnail: string | null;
}

/** `capture_share_targets`. Mirrors Rust's `share::ShareTargets`. */
export interface ShareTargets {
  /** Tags this picker's pictures; `capture_share_art` batches with another token are stale. */
  token: number;
  windows: ShareWindow[];
  displays: ShareDisplay[];
  /** More pictures are on their way as `capture_share_art` batches. */
  pending: boolean;
}

/** One picture for one item. Mirrors Rust's `share::ShareArtItem`. */
export interface ShareArtItem {
  tab: ShareTab;
  id: number;
  thumbnail?: string;
  icon?: string;
}

/** `capture_share_art`. Mirrors Rust's `share::ShareArt`. */
export interface ShareArt {
  token: number;
  items: ShareArtItem[];
}

/** A drive "Save to" offers; `remote` means not synced on this machine. */
export interface CaptureDestinationChoice {
  label: string;
  remote: boolean;
}

/** Why an upload failed, for the card's next step. Mirrors Rust's `FailureReason`. */
export type CaptureFailureReason = "offline" | "storageFull" | "other";

/**
 * Where a capture's upload is, on its preview card. Mirrors Rust's `PreviewStatus`.
 * Rust moves `syncing` to `uploaded` / `failed` itself by following the sync
 * engine's row by path; the card only draws the percent.
 */
export type CapturePreviewStatus =
  | { state: "uploading" }
  /** In the synced folder; the sync engine is uploading it. */
  | { state: "syncing"; linkCopied: boolean; linkError?: string }
  | { state: "uploaded"; linkCopied: boolean; linkError?: string }
  /** `message` is Rust's sentence; `retryable` = Retry applies (false when the sync queue retries it). */
  | { state: "failed"; message: string; reason: CaptureFailureReason; retryable: boolean };

/** What the card says about the link. Mirrors Rust's `LinkState`. */
export type CaptureLinkState =
  | { state: "none" }
  | { state: "public"; copied: boolean }
  | { state: "failed"; message: string }
  | { state: "revoked" }
  | { state: "creating" };

/** Which buttons the card offers now; Rust decides. Mirrors Rust's `CardActions`. */
export interface CapturePreviewActions {
  retry: boolean;
  discard: boolean;
  copyLink: boolean;
  /** "Create link". */
  mintLink: boolean;
  revokeLink: boolean;
  /** Reveal in Finder / Show in Explorer. */
  reveal: boolean;
  /** Open the storage plans: the upload failed because the plan is full. */
  upgrade: boolean;
}

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
  /** `Captures/<fileName>`: the sync engine's row path, to join the percent on. */
  relPath: string;
  link: CaptureLinkState;
  /** Rust's line about the link ("Public link copied"); absent = say nothing. */
  linkText?: string;
  actions: CapturePreviewActions;
  /**
   * In the drive with its link settled (Rust's `settled`): only then does the
   * card slide away on its own. Absent from an older backend = settled once
   * uploaded.
   */
  settled?: boolean;
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
  /** Why the saved shortcut is not working now (Rust's sentence); absent when it is. */
  problem?: string;
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

/**
 * Why recording is unavailable (Rust's `RecordingUnavailable`). Every reason
 * but `unsupportedPlatform` shows the Record modes disabled with Rust's line
 * (a missing helper, an old OS, a missing codec or portal); a platform with
 * no recorder hides them (`disabledRecordingNote`).
 */
export type RecordingUnavailable =
  | "helperMissing"
  | "osTooOld"
  | "unsupportedPlatform"
  | "codecsMissing"
  | "portalMissing"
  | "mediaFeaturePackMissing";

/** Flattened into `capture_support` and the overlay context. */
export interface RecordingAvailability {
  recordingUnavailable: RecordingUnavailable | null;
  /** Rust's line for the reason; null when recording works. */
  recordingUnavailableMessage: string | null;
}

export interface CaptureSupport extends RecordingAvailability, CaptureSurfaces {
  supported: boolean;
  recording: boolean;
  /** Camera only (screen off) may be offered. */
  cameraOnly: boolean;
  screenRecordingPermission: boolean;
  /** System Settings' name for the pane on this Mac; null off macOS. */
  permissionPane: string | null;
}

/** What the permission dialog's button did. Mirrors Rust's `PermissionRequest`. */
export type CapturePermissionRequest = "granted" | "prompted" | "openedSettings";

/** Where Screen Recording stands for this build. Mirrors Rust's `PermissionState`. */
export type CapturePermissionState = "granted" | "notAsked" | "asked" | "stale";

/** `capture_permission_status`. Mirrors Rust's `PermissionStatus`. */
export interface CapturePermissionStatus {
  state: CapturePermissionState;
  /** Signed ad hoc: macOS treats every rebuild as a new app and forgets the grant. */
  adHocSigned: boolean;
}

/** `capture_failed`. `cardShowing`: the card already shows it, so skip the toast. */
export interface CaptureFailed {
  message: string;
  cardShowing: boolean;
}

// Events (listened for by name at each call site, so the IPC contract test
// checks them against Rust): `capture_state_changed` → `CapturePhaseEvent`,
// `capture_delivered` → `CaptureDelivered`, `capture_failed` → `CaptureFailed`,
// `capture_pending_changed` → `CapturePendingChanged`,
// `capture_preview_changed` → `CapturePreviewCard | null`,
// `capture_show_in_folder` → `CaptureShowInFolder`,
// `capture_open_plans` → nothing (the card's Upgrade),
// `capture_shortcut_pressed` → nothing,
// `capture_camera_state` → `CaptureCameraState`,
// `capture_cameras` → `CaptureDevice[]`,
// `capture_mic_level` → `number` (the bar's microphone meter, 0 to 1),
// `capture_options_changed` → `CaptureOptions`,
// `capture_share_art` → `ShareArt` (the bar's overlay only),
// `capture_camera_hover` → `boolean` (the camera window only).

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

/** Save the bar's options; resolves to what Rust stored. See `saveCaptureOptions` for the countdown too. */
export function setCaptureOptions(options: CaptureOptions): Promise<CaptureOptions> {
  return saveCaptureOptions(options).then((saved) => saved.options);
}

/** Save the bar's options; resolves to what Rust stored plus what the bar shows next. */
export function saveCaptureOptions(options: CaptureOptions): Promise<CaptureSavedOptions> {
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

/** "Create link": mint and copy a link for a capture in the drive without one. Rejects with Rust's sentence. */
export function mintCapturePreviewLink(): Promise<void> {
  return invoke("capture_preview_mint_link");
}

/** Revoke the public link this capture made. */
export function revokeCapturePreviewLink(): Promise<void> {
  return invoke("capture_preview_revoke_link");
}

/** Reveal the capture's file in Finder / Explorer (a drive synced here). */
export function revealCapturePreview(): Promise<void> {
  return invoke("capture_preview_reveal");
}

/** Throw away a capture that could not be uploaded (its file is deleted). */
export function discardCapturePreview(): Promise<void> {
  return invoke("capture_preview_discard");
}

/** Upgrade (a full plan): the main window comes forward on the storage plans. */
export function upgradeFromCapturePreview(): Promise<void> {
  return invoke("capture_preview_upgrade");
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

/**
 * Start the capture bar's microphone meter on `device` (the id the bar
 * lists; null = the system default). Levels arrive as `capture_mic_level`
 * (0 to 1). Resolves to the meter's generation for `stopCaptureMicMeter`, or
 * null where there is no meter. Rust measures it in the recording helper:
 * a webview microphone would black out the camera bubble (WebKit lets one
 * page capture at a time).
 */
export function startCaptureMicMeter(device: string | null): Promise<number | null> {
  return invoke("capture_mic_meter_start", { device });
}

/** Stop the meter `startCaptureMicMeter` answered `generation` for. */
export function stopCaptureMicMeter(generation: number): Promise<void> {
  return invoke("capture_mic_meter_stop", { generation });
}

/** The microphone meter's level, 0 (silence) to 1. */
export const MIC_LEVEL_EVENT = "capture_mic_level";

/** Hide or show the camera bubble mid-recording; resolves to whether it shows now. */
export function toggleCaptureCamera(): Promise<boolean> {
  return invoke("capture_camera_toggle");
}

/** The bubble's size strip: Rust saves it and glides the window to its new frame. */
export function setCaptureCameraSize(size: CameraSize): Promise<CameraSize> {
  return invoke("capture_camera_set_size", { size });
}

/** The × on the bubble: camera off while choosing, bubble hidden mid-recording. */
export function dismissCaptureCamera(): Promise<void> {
  return invoke("capture_camera_dismiss");
}

/** Open "Choose what to share": the list now, pictures as `capture_share_art` batches. */
export function getCaptureShareTargets(first: ShareTab): Promise<ShareTargets> {
  return invoke("capture_share_targets", { first });
}

/** The picker closed: stop taking its pictures. */
export function finishCaptureShare(token: number): Promise<void> {
  return invoke("capture_share_done", { token });
}

export function getCaptureOverlayContext(displayId: number): Promise<CaptureOverlayContext> {
  return invoke("capture_overlay_context", { displayId });
}

export function selectCapture(selection: CaptureSelection): Promise<void> {
  return invoke("capture_select", { selection });
}

/** Window mode: the pickable windows on this display again (for live hover). */
export function refreshCaptureWindows(displayId: number): Promise<CaptureWindowTarget[]> {
  return invoke("capture_refresh_windows", { displayId });
}

/** Throw the recording away and start again on the same selection. */
export function restartCapture(): Promise<void> {
  return invoke("capture_restart");
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

export function getCaptureState(): Promise<CapturePhaseEvent> {
  return invoke("capture_state");
}

export function getCaptureSupport(): Promise<CaptureSupport> {
  return invoke("capture_support");
}

export function openScreenRecordingSettings(): Promise<void> {
  return invoke("capture_open_permission_settings");
}

/** The permission dialog's button: macOS's prompt the first time, System Settings after. */
export function requestScreenRecordingPermission(): Promise<CapturePermissionRequest> {
  return invoke("capture_request_permission");
}

/** Where the permission stands for the dialog (Rust decides, including a stale entry). */
export function getScreenRecordingPermissionStatus(): Promise<CapturePermissionStatus> {
  return invoke("capture_permission_status");
}

/** Clear Hippius's own Screen Recording entry and ask macOS again (the stale-entry fix). */
export function resetScreenRecordingPermission(): Promise<CapturePermissionRequest> {
  return invoke("capture_reset_permission");
}

/** Relaunch so macOS applies the grant; Rust remembers it to spot a stale entry after. */
export function relaunchForScreenRecording(): Promise<void> {
  return invoke("capture_relaunch_for_permission");
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
