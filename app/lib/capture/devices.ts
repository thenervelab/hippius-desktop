/**
 * A device name as it is compared: the same Unicode form, straight quotes,
 * single spaces, lower case. The helper and the webview both read the name
 * from macOS, but a Continuity device carries the phone's name ("Ahmad’s
 * iPhone Camera", curly apostrophe), which can reach one side decomposed
 * (NFD) or with a different apostrophe than the other.
 */
export function deviceNameKey(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[\u2018\u2019\u201A\u201B\u02BC\u2032\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

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
  const wanted = deviceNameKey(name);
  if (!wanted) return null;
  const exact = listed.find((d) => deviceNameKey(d.label) === wanted);
  const loose = exact ?? listed.find((d) => deviceNameKey(d.label).includes(wanted));
  return loose?.deviceId ?? null;
}
