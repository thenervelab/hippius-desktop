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
  const cameras = devices.filter((d) => d.kind === "videoinput" && d.deviceId && d.deviceId !== "default");
  if (deviceId && cameras.some((d) => d.deviceId === deviceId)) return deviceId;
  if (!deviceName) return null;
  const wanted = deviceName.trim().toLowerCase();
  const exact = cameras.find((d) => d.label.trim().toLowerCase() === wanted);
  // Some webviews add a USB vendor and product id to the label.
  const loose = exact ?? cameras.find((d) => d.label.toLowerCase().includes(wanted));
  return loose?.deviceId ?? null;
}

/** Whether the list names its cameras yet (it does once one has been opened). */
export function camerasAreNamed(devices: Pick<MediaDeviceInfo, "kind" | "label">[]): boolean {
  return devices.some((d) => d.kind === "videoinput" && d.label.trim() !== "");
}
