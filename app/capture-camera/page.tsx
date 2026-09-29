"use client";

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Circle, Maximize2, VideoOff, X } from "lucide-react";
import "./capture-camera.css";
import {
  cancelCapture,
  dismissCaptureCamera,
  getCaptureCameraContext,
  getCaptureState,
  setCaptureCameras,
  setCaptureCameraSize,
  type CameraSize,
  type CaptureCameraState,
} from "@/app/lib/tauri/capture";
import { camerasAreNamed, camerasFrom, resolveCameraId, videoConstraints } from "./cameraDevices";

/**
 * The camera, Loom style: a round bubble over the screen (small or large), a
 * rounded 16:9 frame at full size, or with the screen turned off, a large
 * stage that is itself the recording. Rust opens, sizes and places the
 * window and says which shape, size and camera (`capture_camera_state`);
 * this page opens the camera, draws it, and offers the size strip.
 *
 * Not content-protected: the bubble is filmed with the screen on purpose.
 * Drag it anywhere; while choosing it sits above the dimmed overlay so it can
 * be placed before recording starts.
 */

const SIZES: { size: CameraSize; label: string }[] = [
  { size: "small", label: "Small camera" },
  { size: "large", label: "Large camera" },
  { size: "full", label: "Full size camera" },
];

function SizeIcon({ size }: { size: CameraSize }) {
  if (size === "full") return <Maximize2 className="size-3.5" />;
  return <Circle className={size === "small" ? "size-2.5" : "size-3.5"} strokeWidth={2.4} />;
}

export default function CaptureCameraPage() {
  const [camera, setCamera] = useState<CaptureCameraState | null>(null);
  const [failed, setFailed] = useState(false);
  // Rust reports the pointer over the window (a window that is not key does
  // not always get the webview's own hover on macOS); the webview's own
  // events cover everywhere else.
  const [hoverRust, setHoverRust] = useState(false);
  const [hoverDom, setHoverDom] = useState(false);
  // Bumped when a camera is plugged in or out, to open the right one again.
  const [devicesSeen, setDevicesSeen] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Which camera the open stream is for ("default" or a webview deviceId). */
  const openFor = useRef<string | null>(null);
  const run = useRef(0);

  useEffect(() => {
    void getCaptureCameraContext().then(setCamera).catch(() => undefined);
    const unlisteners = [
      listen<CaptureCameraState>("capture_camera_state", (e) => setCamera(e.payload)),
      listen<boolean>("capture_camera_hover", (e) => setHoverRust(e.payload)),
    ];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return;
    const onChange = () => setDevicesSeen((n) => n + 1);
    media.addEventListener("devicechange", onChange);
    return () => media.removeEventListener("devicechange", onChange);
  }, []);

  const live = !!camera?.shape && !camera.hidden;
  const deviceId = camera?.deviceId ?? null;
  const deviceName = camera?.deviceName ?? null;

  // Close the camera when the window is told to hide, so its light goes off.
  useEffect(() => {
    if (live) return;
    run.current += 1;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    openFor.current = null;
  }, [live]);

  useEffect(
    () => () => {
      run.current += 1;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  // Open the chosen camera, found by name; again when the choice changes or
  // a camera comes or goes. The stream on screen is kept when it is still
  // the right one, so plugging in a keyboard does not flash the picture.
  useEffect(() => {
    if (!live) return;
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      setFailed(true);
      return;
    }
    const mine = ++run.current;
    const stale = () => run.current !== mine;

    const install = (s: MediaStream, key: string) => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = s;
      openFor.current = key;
      if (videoRef.current) videoRef.current.srcObject = s;
      // An unplugged camera ends its track; look again.
      s.getVideoTracks()[0]?.addEventListener("ended", () => setDevicesSeen((n) => n + 1));
      setFailed(false);
    };

    const open = async () => {
      const before = await media.enumerateDevices();
      if (stale()) return;
      let wanted = resolveCameraId(before, deviceId, deviceName);
      const current = streamRef.current?.getVideoTracks()[0];
      if (current?.readyState === "live" && openFor.current === (wanted ?? "default")) return;

      let s = await media.getUserMedia({ video: videoConstraints(wanted), audio: false });
      if (stale()) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      // Names are readable only once a camera is open: with none readable
      // before, the default was opened just to learn them. Switch to the
      // chosen camera now if it is another one.
      const after = await media.enumerateDevices();
      if (stale()) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      if (wanted === null && deviceName && !camerasAreNamed(before)) {
        const named = resolveCameraId(after, deviceId, deviceName);
        const openedId = s.getVideoTracks()[0]?.getSettings().deviceId;
        if (named && named !== openedId) {
          s.getTracks().forEach((t) => t.stop());
          s = await media.getUserMedia({ video: videoConstraints(named), audio: false });
          if (stale()) {
            s.getTracks().forEach((t) => t.stop());
            return;
          }
        }
        wanted = named;
      }
      install(s, wanted ?? "default");
      void setCaptureCameras(camerasFrom(after)).catch(() => undefined);
    };

    open().catch(() => {
      if (!stale()) setFailed(true);
    });
  }, [live, deviceId, deviceName, devicesSeen]);

  // A re-render can swap the <video> (failed, then recovered); keep it fed.
  useEffect(() => {
    if (videoRef.current && streamRef.current && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  });

  // While choosing, a click on the camera takes focus from the overlay, so
  // Escape has to work here too. Never mid-recording: that would discard it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      void getCaptureState()
        .then((p) => (p.phase === "selecting" ? cancelCapture() : undefined))
        .catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!camera?.shape || camera.hidden) return null;
  const bubble = camera.shape === "bubble";
  const round = bubble && camera.size !== "full";
  // The strip is for the bubble only: the camera-only stage is the recording.
  const showStrip = bubble && (hoverRust || hoverDom);

  return (
    <div
      className="h-full w-full p-1.5"
      data-tauri-drag-region
      onMouseEnter={() => setHoverDom(true)}
      onMouseLeave={() => setHoverDom(false)}
    >
      <div
        data-tauri-drag-region
        title="Drag to move"
        className={`relative h-full w-full cursor-grab overflow-hidden bg-[#1c1d21] shadow-[0_10px_30px_rgba(0,0,0,0.45)] ring-2 ring-white/85 active:cursor-grabbing ${
          round ? "rounded-full" : "rounded-[18px]"
        }`}
      >
        {failed ? (
          <div
            data-tauri-drag-region
            className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center text-[12px] leading-snug text-white/75"
          >
            <VideoOff className="pointer-events-none size-6" aria-hidden />
            <span className="pointer-events-none">
              {round ? "Camera unavailable" : "The camera could not be opened. Check it is connected and allowed in System Settings."}
            </span>
          </div>
        ) : (
          <video
            ref={videoRef}
            data-tauri-drag-region
            autoPlay
            muted
            playsInline
            // Mirrored, as every camera preview is: moving left moves left.
            className="h-full w-full -scale-x-100 object-cover"
          />
        )}

        {showStrip && (
          <div
            role="toolbar"
            aria-label="Camera size"
            className={`absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-black/70 p-1 text-white shadow-lg backdrop-blur ${
              round ? "bottom-[14%]" : "bottom-3"
            }`}
          >
            {SIZES.map(({ size, label }) => (
              <button
                key={size}
                type="button"
                aria-label={label}
                aria-pressed={camera.size === size}
                title={label}
                onClick={() => void setCaptureCameraSize(size).catch(() => undefined)}
                className={`grid size-7 place-items-center rounded-full transition-colors ${
                  camera.size === size ? "bg-white/25" : "hover:bg-white/15"
                }`}
              >
                <SizeIcon size={size} />
              </button>
            ))}
            <span aria-hidden className="mx-0.5 h-4 w-px bg-white/25" />
            <button
              type="button"
              aria-label="Hide camera"
              title="Hide camera"
              onClick={() => void dismissCaptureCamera().catch(() => undefined)}
              className="grid size-7 place-items-center rounded-full hover:bg-white/15"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
