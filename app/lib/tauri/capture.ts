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

export interface CaptureOverlayContext {
  mode: CaptureMode;
  displayId: number;
  /** Front first; empty outside window mode. */
  windows: CaptureWindowTarget[];
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
}

export interface CaptureSupport {
  supported: boolean;
  screenRecordingPermission: boolean;
}

// Events (listened for by name at each call site, so the IPC contract test
// checks them against Rust): `capture_state_changed` → `CapturePhase`,
// `capture_delivered` → `CaptureDelivered`, `capture_failed` → `{ message }`.

export function startCapture(kind: CaptureKind, mode: CaptureMode): Promise<void> {
  return invoke("capture_start", { kind, mode });
}

export function getCaptureOverlayContext(displayId: number): Promise<CaptureOverlayContext> {
  return invoke("capture_overlay_context", { displayId });
}

export function selectCapture(selection: CaptureSelection): Promise<void> {
  return invoke("capture_select", { selection });
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
