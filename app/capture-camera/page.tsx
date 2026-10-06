"use client";

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Circle, Maximize2, Minimize2, Video, VideoOff, X } from "lucide-react";
import "@/app/lib/capture/floating-window.css";
import {
  cancelCapture,
  dismissCaptureCamera,
  getCaptureCameraContext,
  getCaptureState,
  setCaptureCameras,
  setCaptureCameraSize,
  type CaptureCameraState,
} from "@/app/lib/tauri/capture";
import { GLASS_FOCUS } from "@/app/lib/capture/glass";
import { stepIndex } from "@/app/capture-overlay/keyNav";
import {
  CAMERA_FRAME_LAYOUT,
  cameraFrameShape,
  camerasAreNamed,
  camerasFrom,
  cameraCloseLabel,
  exactCameraConstraints,
  MUTE_RECOVERY_MS,
  nextRoundSize,
  openedAnotherCamera,
  resolveCameraId,
  shouldReopenMuted,
  showsPlaceholder,
  sizeControls,
  stripShown,
  VIDEO_TAKES_NO_POINTER,
  videoConstraints,
  type RoundSize,
  type SizeIcon,
} from "./cameraDevices";

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
 * strip that appeared under the pointer mid-recording was in the video.
 * Rust's camera state says when a recording is starting or running
 * (`recording`), so the page follows no phase of its own. The pill hides
 * the bubble while recording. While choosing the strip is always
 * in the page (faded out until the pointer or keyboard focus is on it), so
 * Tab reaches it; the arrow keys move along it. At full size its third button
 * leaves full size (as Escape does), back to the round size from before.
 *
 * The <video> is mirrored, so WebKit's own start-playback button (drawn over
 * a video that is paused or not playing yet) came out as a backwards
 * triangle on the bubble. CSS cannot remove WebKit's modern media controls,
 * so the video stays invisible until it is actually playing, and the page
 * starts playback itself. For the same reason the video never takes the
 * pointer: WebKit drew a pause button over a hovered picture, which did
 * nothing (the click began a window drag) and was filmed. The frame behind
 * it is the drag region; pause is the pill's. Until then, and while the camera is muted, the
 * bubble shows a "starting" placeholder rather than black.
 *
 * This page must be the only one capturing: WebKit mutes every other page's
 * camera and microphone when one starts `getUserMedia`, and a muted camera
 * stays black until it is opened again. The bar's microphone meter is
 * therefore measured by Rust, and a camera muted anyway is opened again
 * after `MUTE_RECOVERY_MS` (`shouldReopenMuted`).
 *
 * Where Rust says the recorder has the camera (`recorderOwnsCamera`: camera
 * only on Wayland, where there is no window to film, so the recorder opens
 * the camera itself), this page closes its stream at once and shows a
 * placeholder: one owner per device. The stage is not filmed there, so the
 * placeholder may say in words what is happening.
 */

function SizeGlyph({ icon }: { icon: SizeIcon }) {
  if (icon === "enterFull") return <Maximize2 className="size-3.5" aria-hidden />;
  if (icon === "exitFull") return <Minimize2 className="size-3.5" aria-hidden />;
  return <Circle className={icon === "small" ? "size-2.5" : "size-3.5"} strokeWidth={2.4} aria-hidden />;
}

/** Start the camera picture; WebKit may leave a new stream paused. */
function playVideo(video: HTMLVideoElement | null) {
  if (!video || !video.paused) return;
  try {
    void video.play()?.catch(() => undefined);
  } catch {
    // Not implemented (tests) or refused: the next stream or event tries again.
  }
}

export default function CaptureCameraPage() {
  const [camera, setCamera] = useState<CaptureCameraState | null>(null);
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
  /** The round size before full size, for "Exit full size" and Escape. */
  const [lastRound, setLastRound] = useState<RoundSize>("small");
  /** The same two for the key listener, which is added once. */
  const lastRoundRef = useRef<RoundSize>("small");
  const cameraRef = useRef<CaptureCameraState | null>(null);
  /** The strip button under the pointer or focus, named in the tooltip. */
  const [tip, setTip] = useState<string | null>(null);
  /** Frames are flowing; until then the video (and WebKit's play button) is hidden. */
  const [playing, setPlaying] = useState(false);
  /** The open camera track is muted (it draws black until it is opened again). */
  const [muted, setMuted] = useState(false);
  /** Reopens in a row for a muted camera; reset when it unmutes. */
  const muteTries = useRef(0);

  useEffect(() => {
    cameraRef.current = camera;
    if (!camera) return;
    const round = nextRoundSize(camera.size, lastRoundRef.current);
    lastRoundRef.current = round;
    setLastRound(round);
  }, [camera]);

  useEffect(() => {
    // The first read can answer late (the context may start the helper to
    // name the camera); an event that landed first is newer, so it gives way.
    let heardCamera = false;
    void getCaptureCameraContext()
      .then((c) => !heardCamera && setCamera(c))
      .catch(() => undefined);
    const unlisteners = [
      listen<CaptureCameraState>("capture_camera_state", (e) => {
        heardCamera = true;
        setCamera(e.payload);
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

  // The recorder has the camera: this page must not hold it.
  const handedOver = !!camera?.recorderOwnsCamera;
  const live = !!camera?.shape && !camera.hidden && !handedOver;
  const deviceId = camera?.deviceId ?? null;
  const deviceName = camera?.deviceName ?? null;

  // Close the camera when the window is told to hide, so its light goes off.
  useEffect(() => {
    if (live) return;
    run.current += 1;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    openFor.current = null;
    setMuted(false);
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
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        playVideo(videoRef.current);
      }
      const track = s.getVideoTracks()[0];
      // An unplugged camera ends its track; look again.
      track?.addEventListener("ended", () => setDevicesSeen((n) => n + 1));
      // Muted by WebKit (another page started capturing) or the system: the
      // picture is black until it unmutes or is opened again.
      setMuted(track?.muted ?? false);
      if (!track?.muted) muteTries.current = 0;
      track?.addEventListener("mute", () => {
        if (streamRef.current === s) setMuted(true);
      });
      track?.addEventListener("unmute", () => {
        if (streamRef.current !== s) return;
        muteTries.current = 0;
        setMuted(false);
      });
      setFailed(false);
    };

    const open = async () => {
      const before = await media.enumerateDevices();
      if (stale()) return;
      let wanted = resolveCameraId(before, deviceId, deviceName);
      const current = streamRef.current?.getVideoTracks()[0];
      // A muted track is not kept: opening the camera again is what unmutes it.
      if (current?.readyState === "live" && !current.muted && openFor.current === (wanted ?? "default")) return;

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
      // Asked for by id, another camera opened: ask for that one exactly.
      // Refused (it went away meanwhile), the camera that opened is kept.
      if (wanted && openedAnotherCamera(wanted, s.getVideoTracks()[0]?.getSettings?.().deviceId)) {
        const exact = await media
          .getUserMedia({ video: exactCameraConstraints(wanted), audio: false })
          .catch(() => null);
        if (stale()) {
          exact?.getTracks().forEach((t) => t.stop());
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        if (exact) {
          s.getTracks().forEach((t) => t.stop());
          s = exact;
        }
      }
      install(s, wanted ?? "default");
      void setCaptureCameras(camerasFrom(after)).catch(() => undefined);
    };

    open().catch(() => {
      if (!stale()) setFailed(true);
    });
  }, [live, deviceId, deviceName, devicesSeen]);

  // A camera that stays muted is opened again, a bounded number of times.
  useEffect(() => {
    if (!live || !muted) return;
    const t = window.setTimeout(() => {
      if (!shouldReopenMuted(true, muteTries.current)) return;
      muteTries.current += 1;
      setDevicesSeen((n) => n + 1);
    }, MUTE_RECOVERY_MS);
    return () => window.clearTimeout(t);
  }, [live, muted, devicesSeen]);

  // A re-render can swap the <video> (failed, then recovered); keep it fed.
  useEffect(() => {
    if (videoRef.current && streamRef.current && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      playVideo(videoRef.current);
    }
  });

  // While choosing, a click on the camera takes focus from the overlay, so
  // Escape has to work here too: it leaves full size first, and otherwise
  // cancels. Never mid-recording: that would discard it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const now = cameraRef.current;
      if (now?.size === "full" && stripShown(now)) {
        e.preventDefault();
        void setCaptureCameraSize(lastRoundRef.current).catch(() => undefined);
        return;
      }
      void getCaptureState()
        .then((p) => (p.phase === "selecting" ? cancelCapture() : undefined))
        .catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!camera?.shape || camera.hidden) return null;
  if (handedOver) {
    return (
      <div className="fixed inset-0 p-1.5" data-testid="camera-window" data-tauri-drag-region>
        <div
          data-tauri-drag-region
          data-testid="camera-handed-over"
          role="status"
          className={`flex flex-col items-center justify-center gap-2 overflow-hidden bg-gradient-to-br from-[#2a2c33] to-[#1c1d21] px-4 text-center ring-2 ring-white/85 ${cameraFrameShape(false)}`}
        >
          <span aria-hidden className="pointer-events-none flex items-center gap-2">
            <span className="size-2.5 rounded-full bg-[#e5484d]" />
            <Video className="size-6 text-white/75" />
          </span>
          <span className="pointer-events-none text-[13px] font-medium leading-snug text-white/85">
            Recording your camera
          </span>
        </div>
      </div>
    );
  }
  const bubble = camera.shape === "bubble";
  const round = bubble && camera.size !== "full";
  // The strip is for the bubble only (the camera-only stage is the
  // recording), and only while choosing.
  const hasStrip = bubble && stripShown(camera);
  const placeholder = showsPlaceholder(playing, muted);
  const hovered = hoverRust || hoverDom;
  const closeLabel = cameraCloseLabel(camera);
  const controls = sizeControls(camera.size, lastRound);
  // The Tab stop: the size shown now, or the full-size toggle while full.
  const focusIndex = Math.max(
    0,
    controls.findIndex((c) => c.pressed || c.icon === "exitFull"),
  );

  const onStripKey = (e: React.KeyboardEvent) => {
    const buttons = Array.from(stripRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const next = stepIndex(e.key, buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length, "horizontal");
    if (next === null) return;
    e.preventDefault();
    buttons[next]?.focus();
  };

  return (
    // Sized by the window, never by the video. <html> and <body> have no
    // height here, so an `h-full` root collapsed to the content, and the
    // content was the camera's own 16:9 picture: the round bubble came out
    // as a 16:9 pill inside its square window. The full-size frame and the
    // stage are 16:9 windows, which is why only the round sizes looked wrong.
    <div
      className={`fixed inset-0 p-1.5 ${CAMERA_FRAME_LAYOUT}`}
      data-testid="camera-window"
      data-tauri-drag-region
      onMouseEnter={() => setHoverDom(true)}
      onMouseLeave={() => setHoverDom(false)}
    >
      <div
        data-tauri-drag-region
        data-testid="camera-frame"
        className={`relative cursor-grab overflow-hidden bg-[#1c1d21] shadow-[0_10px_30px_rgba(0,0,0,0.45)] ring-2 ring-white/85 transition-[border-radius] duration-200 active:cursor-grabbing motion-reduce:transition-none ${cameraFrameShape(round)}`}
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
            autoPlay
            muted
            playsInline
            disablePictureInPicture
            onPlaying={() => setPlaying(true)}
            // WebKit pauses a video it cannot see; hide it (its play button
            // would show, mirrored) and start it again.
            onPause={(e) => {
              setPlaying(false);
              playVideo(e.currentTarget);
            }}
            onEmptied={() => setPlaying(false)}
            data-playing={playing}
            // Mirrored, as every camera preview is: moving left moves left.
            // Never under the pointer (`VIDEO_TAKES_NO_POINTER`): WebKit drew
            // its own pause button over a hovered video, which did nothing
            // and was filmed. The frame behind it is the drag region.
            className={`${VIDEO_TAKES_NO_POINTER} h-full w-full -scale-x-100 object-cover transition-opacity duration-150 motion-reduce:transition-none ${
              placeholder ? "opacity-0" : "opacity-100"
            }`}
          />
        )}

        {!failed && placeholder && (
          // Until the first frame (and while muted): a soft placeholder, never
          // a black disc. The bubble is filmed, so it says nothing in words.
          <div
            data-tauri-drag-region
            data-testid="camera-starting"
            aria-label="Starting camera"
            role="img"
            className="absolute inset-0 grid place-items-center bg-gradient-to-br from-[#2a2c33] to-[#1c1d21] animate-pulse motion-reduce:animate-none"
          >
            <Video className="pointer-events-none size-6 text-white/60" aria-hidden />
          </div>
        )}

        {hasStrip && (
          <div
            className={`absolute left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1 ${round ? "bottom-[14%]" : "bottom-3"}`}
          >
            {/* The name of the button under the pointer or focus. A native
                title would open a system tooltip window over the bubble. */}
            <span
              role="tooltip"
              id="camera-strip-tip"
              aria-hidden={!tip}
              className={`pointer-events-none whitespace-nowrap rounded-md bg-[#000]/80 px-2 py-0.5 text-[11px] font-medium text-white transition-opacity duration-100 motion-reduce:transition-none ${
                tip ? "opacity-100" : "opacity-0"
              }`}
            >
              {tip ?? ""}
            </span>
            <div
              ref={stripRef}
              role="toolbar"
              aria-label="Camera size"
              onKeyDown={onStripKey}
              className={`flex items-center gap-0.5 rounded-full bg-[#000]/70 p-1 text-white shadow-lg backdrop-blur transition-opacity duration-150 motion-reduce:transition-none ${
                hovered ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100"
              }`}
            >
              {controls.map((c, i) => (
                <button
                  key={c.key}
                  type="button"
                  aria-label={c.label}
                  aria-pressed={c.pressed}
                  aria-describedby={tip === c.label ? "camera-strip-tip" : undefined}
                  // One Tab stop into the strip; the arrows move along it.
                  tabIndex={i === focusIndex ? 0 : -1}
                  onClick={() => void setCaptureCameraSize(c.target).catch(() => undefined)}
                  onMouseEnter={() => setTip(c.label)}
                  onMouseLeave={() => setTip(null)}
                  onFocus={() => setTip(c.label)}
                  onBlur={() => setTip(null)}
                  className={`grid size-7 place-items-center rounded-full transition-colors ${GLASS_FOCUS} ${
                    c.pressed ? "bg-white/25" : "hover:bg-white/15"
                  }`}
                >
                  <SizeGlyph icon={c.icon} />
                </button>
              ))}
              <span aria-hidden className="mx-0.5 h-4 w-px bg-white/25" />
              <button
                type="button"
                aria-label={closeLabel}
                tabIndex={-1}
                onClick={() => void dismissCaptureCamera().catch(() => undefined)}
                onMouseEnter={() => setTip(closeLabel)}
                onMouseLeave={() => setTip(null)}
                onFocus={() => setTip(closeLabel)}
                onBlur={() => setTip(null)}
                className={`grid size-7 place-items-center rounded-full hover:bg-white/15 ${GLASS_FOCUS}`}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
