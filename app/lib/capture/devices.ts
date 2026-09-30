/**
 * The webview's `deviceId` for a camera or microphone chosen in the bar. The
 * helper lists devices by the system's own ids, which the webview never uses,
 * so the device is found by name: an exact match first, then a label that
 * contains the name (some webviews add a USB vendor id or " (Built-in)").
 * Null means open the default device. The "default" alias some platforms add
 * is skipped, so it never shadows the real entry.
 */
export function deviceIdByName(
  devices: Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">[],
  kind: "audioinput" | "videoinput",
  name: string | null,
): string | null {
  if (!name) return null;
  const listed = devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== "default");
  const wanted = name.trim().toLowerCase();
  const exact = listed.find((d) => d.label.trim().toLowerCase() === wanted);
  const loose = exact ?? listed.find((d) => d.label.toLowerCase().includes(wanted));
  return loose?.deviceId ?? null;
}
