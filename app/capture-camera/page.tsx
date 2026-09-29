"use client";

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { VideoOff } from "lucide-react";
import "./capture-camera.css";
import {
  cancelCapture,
  getCaptureCameraContext,
  getCaptureState,
  setCaptureCameras,
  type CaptureCameraState,
} from "@/app/lib/tauri/capture";
import { camerasFrom, videoConstraints } from "./cameraDevices";

/**
 * The camera, Loom style: a round bubble over the screen, or with the screen
 * turned off, a large stage that is itself the recording. Rust opens, sizes
 * and places the window and says which shape and which camera
 * (`capture_camera_state`); this page only opens the camera and draws it.
 *
 * Not content-protected: the bubble is filmed with the screen on purpose.
 * Drag it anywhere; while choosing it sits above the dimmed overlay so it can
 * be placed before recording starts.
 */
export default function CaptureCameraPage() {
  const [camera, setCamera] = useState<CaptureCameraState | null>(null);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    void getCaptureCameraContext().then(setCamera).catch(() => undefined);
    const unlisten = listen<CaptureCameraState>("capture_camera_state", (e) => setCamera(e.payload));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const live = !!camera?.shape && !camera.hidden;
  const deviceId = camera?.deviceId ?? null;

  // Open the chosen camera; close it when the window is told to hide, so the
  // camera light goes off with it.
  useEffect(() => {
    if (!live) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    setFailed(false);
    navigator.mediaDevices
      .getUserMedia({ video: videoConstraints(deviceId), audio: false })
      .then(async (s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
        // Names are only readable once the camera is open.
        const devices = await navigator.mediaDevices.enumerateDevices();
        void setCaptureCameras(camerasFrom(devices)).catch(() => undefined);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [live, deviceId]);

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

  return (
    <div className="h-full w-full p-1.5" data-tauri-drag-region>
      <div
        data-tauri-drag-region
        title="Drag to move"
        className={`relative h-full w-full cursor-grab overflow-hidden bg-[#1c1d21] shadow-[0_10px_30px_rgba(0,0,0,0.45)] ring-2 ring-white/85 active:cursor-grabbing ${
          bubble ? "rounded-full" : "rounded-[18px]"
        }`}
      >
        {failed ? (
          <div
            data-tauri-drag-region
            className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center text-[12px] leading-snug text-white/75"
          >
            <VideoOff className="pointer-events-none size-6" aria-hidden />
            <span className="pointer-events-none">
              {bubble ? "Camera unavailable" : "The camera could not be opened. Check it is connected and allowed in System Settings."}
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
      </div>
    </div>
  );
}
