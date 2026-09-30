"use client";

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Circle, Maximize2, VideoOff, X } from "lucide-react";
import "@/app/lib/capture/floating-window.css";
import {
  cancelCapture,
  dismissCaptureCamera,
  getCaptureCameraContext,
  getCaptureState,
  setCaptureCameras,
  setCaptureCameraSize,
  type CameraSize,
  type CaptureCameraState,
  type CapturePhase,
} from "@/app/lib/tauri/capture";
import { GLASS_FOCUS } from "@/app/lib/capture/glass";
import { stepIndex } from "@/app/capture-overlay/keyNav";
import { camerasAreNamed, camerasFrom, cameraCloseLabel, resolveCameraId, stripShown, videoConstraints } from "./cameraDevices";

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
 *
 * The size strip exists only while choosing: this window is filmed, so a
 * strip that appeared under the pointer mid-recording was in the video. The
 * pill hides the bubble while recording. While choosing the strip is always
 * in the page (faded out until the pointer or keyboard focus is on it), so
 * Tab reaches it; the arrow keys move along it.
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
  // The session's phase; null until known, and the strip waits for it.
  const [phase, setPhase] = useState<CapturePhase | null>(null);
  const [failed, setFailed] = useState(false);
  const stripRef = useRef<HTMLDivElement | null>(null);
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
    // The first reads can answer late (the context may start the helper to
    // name the camera); an event that landed first is newer, so they give way.
    let heardCamera = false;
    let heardPhase = false;
    void getCaptureCameraContext()
      .then((c) => !heardCamera && setCamera(c))
      .catch(() => undefined);
    void getCaptureState()
      .then((p) => !heardPhase && setPhase(p))
      .catch(() => undefined);
    const unlisteners = [
      listen<CaptureCameraState>("capture_camera_state", (e) => {
        heardCamera = true;
        setCamera(e.payload);
      }),
      listen<CapturePhase>("capture_state_changed", (e) => {
        heardPhase = true;
        setPhase(e.payload);
      }),
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
  // The strip is for the bubble only (the camera-only stage is the
  // recording), and only while choosing.
  const hasStrip = bubble && stripShown(phase);
  const hovered = hoverRust || hoverDom;
  const closeLabel = cameraCloseLabel(phase);

  const onStripKey = (e: React.KeyboardEvent) => {
    const buttons = Array.from(stripRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const next = stepIndex(e.key, buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length, "horizontal");
    if (next === null) return;
    e.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <div
      className="h-full w-full p-1.5"
      data-tauri-drag-region
      onMouseEnter={() => setHoverDom(true)}
      onMouseLeave={() => setHoverDom(false)}
    >
      <div
        data-tauri-drag-region
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

        {hasStrip && (
          <div
            ref={stripRef}
            role="toolbar"
            aria-label="Camera size"
            onKeyDown={onStripKey}
            className={`absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-black/70 p-1 text-white shadow-lg backdrop-blur transition-opacity duration-150 motion-reduce:transition-none ${
              round ? "bottom-[14%]" : "bottom-3"
            } ${hovered ? "opacity-100" : "pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100"}`}
          >
            {SIZES.map(({ size, label }, i) => (
              <button
                key={size}
                type="button"
                aria-label={label}
                aria-pressed={camera.size === size}
                // One Tab stop into the strip; the arrows move along it.
                tabIndex={camera.size === size || (i === 0 && !SIZES.some((x) => x.size === camera.size)) ? 0 : -1}
                onClick={() => void setCaptureCameraSize(size).catch(() => undefined)}
                className={`grid size-7 place-items-center rounded-full transition-colors ${GLASS_FOCUS} ${
                  camera.size === size ? "bg-white/25" : "hover:bg-white/15"
                }`}
              >
                <SizeIcon size={size} />
              </button>
            ))}
            <span aria-hidden className="mx-0.5 h-4 w-px bg-white/25" />
            <button
              type="button"
              aria-label={closeLabel}
              tabIndex={-1}
              onClick={() => void dismissCaptureCamera().catch(() => undefined)}
              className={`grid size-7 place-items-center rounded-full hover:bg-white/15 ${GLASS_FOCUS}`}
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
