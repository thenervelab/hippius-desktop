/**
 * The camera page's reports, in words, for the app log (`reportCameraStep`,
 * logged by Rust as `camera:` lines). When the bubble shows only its
 * placeholder nothing on screen says why, so each step says what the page
 * saw: the cameras WebKit listed, what was asked for, the error, the track
 * and the video. Device names only: never a full device id (a short prefix
 * is enough to tell two apart) and nothing else about the user.
 */

type DeviceLike = Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">;

/** A webview device id cut to a prefix that still tells two cameras apart. */
export function shortId(id: string | null | undefined): string {
  if (!id) return "none";
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

/** The cameras `enumerateDevices` found, by name. */
export function describeDevices(devices: DeviceLike[]): string {
  const cameras = devices.filter((d) => d.kind === "videoinput");
  if (cameras.length === 0) return "no cameras listed";
  const names = cameras.map((d) => (d.label.trim() ? `"${d.label.trim()}"` : `(unnamed ${shortId(d.deviceId)})`));
  return `${cameras.length} camera${cameras.length === 1 ? "" : "s"}: ${names.join(", ")}`;
}

/** What `getUserMedia` was asked for, with the device id shortened. */
export function describeConstraints(c: MediaTrackConstraints): string {
  const parts: string[] = [];
  const id = c.deviceId;
  if (id && typeof id === "object" && !Array.isArray(id)) {
    const d = id as ConstrainDOMStringParameters;
    if (d.exact) parts.push(`deviceId exact ${shortId(String(d.exact))}`);
    if (d.ideal) parts.push(`deviceId ideal ${shortId(String(d.ideal))}`);
  } else if (typeof id === "string") {
    parts.push(`deviceId ${shortId(id)}`);
  } else {
    parts.push("default camera");
  }
  const ideal = (v: unknown) => (v && typeof v === "object" && "ideal" in v ? (v as { ideal: unknown }).ideal : v);
  if (c.width !== undefined || c.height !== undefined) parts.push(`size ${String(ideal(c.width))}x${String(ideal(c.height))}`);
  if (c.frameRate !== undefined) parts.push(`fps ${String(ideal(c.frameRate))}`);
  return parts.join(", ");
}

/** A rejected `getUserMedia` (or anything thrown while opening): its name and message. */
export function describeError(e: unknown): string {
  if (e && typeof e === "object") {
    const err = e as { name?: unknown; message?: unknown; constraint?: unknown };
    const name = typeof err.name === "string" && err.name ? err.name : "Error";
    const message = typeof err.message === "string" ? err.message : "";
    const constraint = typeof err.constraint === "string" && err.constraint ? ` (constraint ${err.constraint})` : "";
    return `${name}: ${message || "(no message)"}${constraint}`;
  }
  return `thrown: ${String(e)}`;
}

type TrackLike = Partial<Pick<MediaStreamTrack, "label" | "readyState" | "muted" | "enabled">> & {
  getSettings?: () => MediaTrackSettings;
};

/** The open camera track: which camera, and whether it is live, muted or enabled. */
export function describeTrack(track: TrackLike | null | undefined): string {
  if (!track) return "no track";
  let settings: MediaTrackSettings = {};
  try {
    settings = track.getSettings?.() ?? {};
  } catch {
    // Not every engine answers; the rest still says enough.
  }
  const size = settings.width || settings.height ? ` ${settings.width ?? "?"}x${settings.height ?? "?"}` : "";
  const fps = settings.frameRate ? `@${Math.round(settings.frameRate)}` : "";
  const label = track.label ? `"${track.label}"` : "(no label)";
  return `${label} ${track.readyState ?? "?"} muted=${String(track.muted)} enabled=${String(track.enabled)}${size}${fps}`;
}

type VideoLike = Pick<HTMLVideoElement, "readyState" | "paused" | "videoWidth" | "videoHeight"> & { srcObject: unknown };

/** The <video> showing the camera: whether it has a stream and any frame yet. */
export function describeVideo(video: VideoLike | null | undefined): string {
  if (!video) return "no video element";
  return `video readyState=${video.readyState} paused=${String(video.paused)} size=${video.videoWidth}x${video.videoHeight} stream=${video.srcObject ? "yes" : "no"}`;
}

/** Whether this webview offers `getUserMedia` at all, and over what. */
export function describeMediaSupport(nav: { mediaDevices?: unknown }, secure: boolean | undefined, origin: string): string {
  return `navigator.mediaDevices ${nav.mediaDevices ? "present without getUserMedia" : "missing"}; secure context ${String(secure)}; origin ${origin}`;
}
