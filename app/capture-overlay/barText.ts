import type { CaptureDevice, CaptureKind, CaptureMode, CaptureOptions, ShareTab } from "@/app/lib/tauri/capture";

/**
 * What the capture bar shows, decided without React so it can be tested:
 * which mode buttons exist, what the button says, and the one-line hint.
 * Rust decides what a capture MEANS (`capture::bar`); this only words it.
 */

export interface BarMode {
  kind: CaptureKind;
  mode: CaptureMode;
  /** Accessible name and tooltip, macOS's own wording. */
  label: string;
}

const SHOTS: BarMode[] = [
  { kind: "screenshot", mode: "screen", label: "Capture entire screen" },
  { kind: "screenshot", mode: "window", label: "Capture selected window" },
  { kind: "screenshot", mode: "area", label: "Capture selected portion" },
];

const RECORDINGS: BarMode[] = [
  { kind: "recording", mode: "screen", label: "Record entire screen" },
  { kind: "recording", mode: "window", label: "Record selected window" },
  { kind: "recording", mode: "area", label: "Record selected portion" },
];

/** The bar's two groups; the recording group only where recording works. */
export function barGroups(recordingAvailable: boolean): BarMode[][] {
  return recordingAvailable ? [SHOTS, RECORDINGS] : [SHOTS];
}

/** "Capture" or "Record", on the bar's main button. */
export function confirmLabel(kind: CaptureKind): string {
  return kind === "recording" ? "Record" : "Capture";
}

/**
 * The line above the bar. `hasArea` is whether an area is drawn anywhere, and
 * `onThisDisplay` whether the pointer is on this display (a screen hint only
 * makes sense for the screen being pointed at).
 */
export function barHint(kind: CaptureKind, mode: CaptureMode, hasArea: boolean, cameraOnly = false): string {
  if (kind === "recording" && cameraOnly) return "Drag your camera where you like, then press Return to record";
  const verb = kind === "recording" ? "record" : "capture";
  if (mode === "window") return `Click a window to ${verb} it`;
  if (mode === "screen") return `Click a screen to ${verb} it, or press Return`;
  return hasArea ? `Drag to adjust, then press Return to ${verb}` : `Drag to choose what to ${verb}`;
}

/** The timer choices the Options menu offers, as Rust accepts them. */
export const TIMER_OPTIONS: readonly { secs: number; label: string }[] = [
  { secs: 0, label: "None" },
  { secs: 5, label: "5 seconds" },
  { secs: 10, label: "10 seconds" },
];

/** Where remembered areas live: one area, on the display it was drawn on. */
export const LAST_AREA_KEY = "hippius:capture-last-area";

/**
 * What a source chip on the recording row says: the chosen device's name, the
 * default when none is chosen, or "No camera" / "No microphone" when off. A
 * chosen device that is no longer listed (unplugged) reads as the default,
 * which is what Rust and the camera fall back to.
 */
export function sourceLabel(
  on: boolean,
  chosen: string | null,
  devices: CaptureDevice[],
  source: "camera" | "microphone",
): string {
  if (!on) return source === "camera" ? "No camera" : "No microphone";
  const match = chosen ? devices.find((d) => d.id === chosen) : undefined;
  if (match) return match.name;
  const fallback = devices.find((d) => d.isDefault);
  if (fallback) return fallback.name;
  return source === "camera" ? "Default camera" : "Default microphone";
}

/**
 * Whether `device` is the one in use, for its menu's check mark: the chosen
 * one, or with none chosen (or the chosen one unplugged) the system default,
 * else the first listed.
 */
export function isDeviceInUse(device: CaptureDevice, chosen: string | null, devices: CaptureDevice[]): boolean {
  if (chosen && devices.some((d) => d.id === chosen)) return device.id === chosen;
  const fallback = devices.find((d) => d.isDefault) ?? devices[0];
  return fallback?.id === device.id;
}

/** Which tab "Choose what to share" opens on for the bar's mode. */
export function shareTabFor(mode: CaptureMode): ShareTab {
  return mode === "window" ? "window" : "screen";
}

/** A source picked from a chip's menu: `null` device = turn it off. */
export function pickCamera(options: CaptureOptions, deviceId: string | null | "default"): CaptureOptions {
  if (deviceId === null) {
    // Camera off with the screen off would record nothing: the screen comes back.
    return { ...options, camera: false, screen: true };
  }
  return { ...options, camera: true, cameraDevice: deviceId === "default" ? null : deviceId };
}

export function pickMicrophone(options: CaptureOptions, deviceId: string | null | "default"): CaptureOptions {
  if (deviceId === null) return { ...options, microphone: false };
  return { ...options, microphone: true, microphoneDevice: deviceId === "default" ? null : deviceId };
}

/** The Screen chip: turning the screen off records the camera alone, so the camera comes on. */
export function toggleScreen(options: CaptureOptions): CaptureOptions {
  return options.screen ? { ...options, screen: false, camera: true } : { ...options, screen: true };
}
