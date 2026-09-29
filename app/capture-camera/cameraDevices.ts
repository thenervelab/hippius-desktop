import type { CaptureDevice } from "@/app/lib/tauri/capture";

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
