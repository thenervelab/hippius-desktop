import { deviceIdByName } from "@/app/lib/capture/devices";
import type { CameraSize, CaptureCameraState, CaptureDevice } from "@/app/lib/tauri/capture";

/**
 * The cameras `enumerateDevices` found, as the bar's picker lists them.
 * A camera the webview cannot name yet (no permission) still gets a label, and
 * the default device's duplicate entry some platforms add is dropped.
 */
export function camerasFrom(devices: Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">[]): CaptureDevice[] {
  const cameras = devices.filter((d) => d.kind === "videoinput" && d.deviceId && d.deviceId !== "default");
  return cameras.map((d, i) => ({ id: d.deviceId, name: d.label.trim() || `Camera ${i + 1}` }));
}

/**
 * The camera window's layout: the frame centred in the window, inside the
 * page's 6 px margin (`p-1.5`, where the ring and the shadow sit). The
 * window, not the video, sets the size: `h-full` against this page's
 * auto-height <body> took the camera's 16:9 picture as the height, so the
 * round bubble came out as a pill.
 */
export const CAMERA_FRAME_LAYOUT = "flex items-center justify-center";

/**
 * The frame's size and shape. Small and large are a true circle: a square as
 * wide as the window allows and never taller than it (`aspect-square`,
 * capped at the window's height less the margin), so even a window a pixel
 * off square (a fractional size rounded at another scale, a glide between
 * sizes) draws a circle, not an oval. Full size and the camera-only stage
 * fill their 16:9 window with 18 px corners (the helper's `stageInset` and
 * the Windows recorder's bubble shape assume both).
 */
export function cameraFrameShape(round: boolean): string {
  return round ? "aspect-square w-full max-w-[calc(100vh-0.75rem)] rounded-full" : "h-full w-full rounded-[18px]";
}

/**
 * What to ask `getUserMedia` for. A chosen camera that has gone (unplugged)
 * falls back to the default rather than failing: `ideal`, not `exact`.
 */
export function videoConstraints(deviceId: string | null): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  };
}

/**
 * What to ask for when `videoConstraints` opened another camera than the one
 * chosen: that camera and no other. `ideal` is only a preference, which
 * WebKit may weigh against the size and frame rate and lose, so a camera
 * switched from the pill could keep showing the camera from before.
 */
export function exactCameraConstraints(deviceId: string): MediaTrackConstraints {
  return { ...videoConstraints(null), deviceId: { exact: deviceId } };
}

/**
 * Whether the stream that opened is another camera than the one asked for
 * (`wanted`, a webview `deviceId`; null = the default, which any camera is).
 * Unknown when WebKit does not say which one opened: then it is kept.
 */
export function openedAnotherCamera(wanted: string | null, opened: string | undefined): boolean {
  return !!wanted && !!opened && opened !== wanted;
}

/**
 * The class that keeps the camera picture from ever being under the pointer.
 * WebKit draws its own media controls over a hovered <video>, even one
 * without the `controls` attribute: a pause button showed on the bubble, on
 * some hovers and not others (a window that is not key gets hover only now
 * and then), did nothing when clicked (the click started a window drag), and
 * was filmed. The bubble's own controls are the pill's; the frame behind the
 * picture is what is dragged.
 */
export const VIDEO_TAKES_NO_POINTER = "pointer-events-none";

/**
 * The webview's `deviceId` for the camera the bar chose. The bar lists the
 * system's cameras, whose ids the webview never uses, so the camera is found
 * by the id first (a choice from an older build, or the webview's own list)
 * and then by name. Null means open the default camera.
 */
export function resolveCameraId(
  devices: Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">[],
  deviceId: string | null,
  deviceName: string | null,
): string | null {
  if (deviceId && devices.some((d) => d.kind === "videoinput" && d.deviceId === deviceId && deviceId !== "default")) {
    return deviceId;
  }
  return deviceIdByName(devices, "videoinput", deviceName);
}

/** Whether the list names its cameras yet (it does once one has been opened). */
export function camerasAreNamed(devices: Pick<MediaDeviceInfo, "kind" | "label">[]): boolean {
  return devices.some((d) => d.kind === "videoinput" && d.label.trim() !== "");
}

/**
 * Whether the bubble's size strip is drawn. Only while choosing: the camera
 * window is filmed with the screen, so a strip shown mid-recording ended up
 * in the video. Rust says when a recording is starting or running
 * (`recording`); nothing drawn before the first state arrives.
 */
export function stripShown(camera: CaptureCameraState | null): boolean {
  return camera?.shape === "bubble" && !camera.recording;
}

/**
 * What the bubble's × does: while choosing it turns the camera off (saved in
 * the options); while recording it only hides the bubble, and the pill
 * brings it back.
 */
export function cameraCloseLabel(camera: CaptureCameraState | null): string {
  return camera?.recording ? "Hide camera" : "Turn camera off";
}

/** A round bubble's size: what "Exit full size" goes back to. */
export type RoundSize = Exclude<CameraSize, "full">;

/** Which picture a size button draws: each points the way it acts. */
export type SizeIcon = "small" | "large" | "enterFull" | "exitFull";

export interface SizeControl {
  /** Stable key for the button. */
  key: CameraSize;
  /** The size a click asks Rust for. */
  target: CameraSize;
  label: string;
  icon: SizeIcon;
  /** `aria-pressed`: the size shown now. Undefined on the full-size toggle while full, which is an action ("Exit full size"), not a state. */
  pressed: boolean | undefined;
}

/**
 * The strip's size buttons, Loom style: small, large, and a full-size toggle.
 * At full size the third button leaves it ("Exit full size", back to the
 * round size the bubble had before) instead of asking for full again, which
 * did nothing and left no obvious way back.
 */
export function sizeControls(size: CameraSize, lastRound: RoundSize): SizeControl[] {
  const full = size === "full";
  return [
    { key: "small", target: "small", label: "Small camera", icon: "small", pressed: size === "small" },
    { key: "large", target: "large", label: "Large camera", icon: "large", pressed: size === "large" },
    full
      ? { key: "full", target: lastRound, label: "Exit full size", icon: "exitFull", pressed: undefined }
      : { key: "full", target: "full", label: "Full size camera", icon: "enterFull", pressed: false },
  ];
}

/** The round size to remember: the current one, or the last one while full. */
export function nextRoundSize(size: CameraSize, lastRound: RoundSize): RoundSize {
  return size === "full" ? lastRound : size;
}

/**
 * How long a muted camera is given to come back on its own before the page
 * opens it again, and how many times in a row it tries.
 *
 * WebKit lets one page per process capture at a time: another Hippius window
 * starting `getUserMedia` mutes this one, and a muted track stays muted (a
 * black picture) until this page asks for the camera again, even after the
 * other page let go. Opening it again takes it back. Nothing else in the app
 * opens a camera or microphone in a webview any more (the bar's meter is
 * Rust's), so this is the safety net, bounded so a camera muted for good
 * (the screen locked) does not loop.
 */
export const MUTE_RECOVERY_MS = 1500;
export const MUTE_RECOVERY_TRIES = 3;

/** Whether a muted camera should be opened again, after `tries` already. */
export function shouldReopenMuted(muted: boolean, tries: number): boolean {
  return muted && tries < MUTE_RECOVERY_TRIES;
}

/**
 * Whether the bubble shows its "starting" placeholder instead of the
 * picture: until the first frame plays, and while the camera is muted (a
 * muted camera draws black). Never black on the bubble, which is filmed.
 */
export function showsPlaceholder(playing: boolean, muted: boolean): boolean {
  return !playing || muted;
}
