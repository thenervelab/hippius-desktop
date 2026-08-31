import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { Loader2, Info, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { useViewableFileUrl } from "@/app/lib/hooks/useViewableFileUrl";
import { FILE_VIEWER_OVERLAY_Z_INDEX } from "@/app/components/page-sections/drive/file-viewer";
import { usePreparedImagePreview } from "@/app/lib/hooks/usePreparedImagePreview";
import PreviewSurface from "./PreviewSurface";
import { PreviewFallback } from "./PreviewState";

interface MediaSize {
  width: number;
  height: number;
}

const LIVE_METADATA_TIMEOUT_MS = 5_000;
const LIVE_RENDER_PROBE_TIMEOUT_MS = 2_200;
const LIVE_STALL_TIMEOUT_MS = 2_200;
const LIVE_PROGRESS_POLL_MS = 200;

// `lib.dom` declares these three as REQUIRED on `HTMLVideoElement`, but the
// Linux WebKitGTK WebView ships without them, which is exactly what the live
// playback watchdog probes for. They are therefore `Omit`ted and re-declared as
// optional; `interface ... extends HTMLVideoElement` cannot widen a required
// member to optional (TS2430) and failed `pnpm typecheck`.
type ObservableVideo = Omit<
  HTMLVideoElement,
  "requestVideoFrameCallback" | "cancelVideoFrameCallback" | "getVideoPlaybackQuality"
> & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: { mediaTime: number }) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  getVideoPlaybackQuality?: () => { totalVideoFrames: number };
};

function containedSize(media: MediaSize, area: MediaSize): MediaSize | null {
  if (
    media.width <= 0 ||
    media.height <= 0 ||
    area.width <= 0 ||
    area.height <= 0
  ) {
    return null;
  }
  const scale = Math.min(
    1,
    area.width / media.width,
    area.height / media.height,
  );
  return {
    width: Math.max(1, Math.round(media.width * scale)),
    height: Math.max(1, Math.round(media.height * scale)),
  };
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("error", handleError);
    };
    const handleLoaded = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Live Photo metadata could not be decoded"));
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Live Photo metadata timed out"));
    }, LIVE_METADATA_TIMEOUT_MS);

    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("error", handleError);
    video.load();
  });
}

function getPresentedFrameCount(video: ObservableVideo): number | null {
  try {
    return video.getVideoPlaybackQuality?.().totalVideoFrames ?? null;
  } catch {
    return null;
  }
}

function createVideoFrameSampler(video: HTMLVideoElement) {
  const canvas = document.createElement("canvas");
  canvas.width = 12;
  canvas.height = 12;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let unavailable = !context;

  return (): Uint8Array | null => {
    if (
      unavailable ||
      !context ||
      video.readyState < 2 ||
      video.videoWidth <= 0 ||
      video.videoHeight <= 0
    ) {
      return null;
    }
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const rgba = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      const signature = new Uint8Array(canvas.width * canvas.height);
      for (let pixel = 0; pixel < signature.length; pixel += 1) {
        const offset = pixel * 4;
        signature[pixel] = Math.round(
          (rgba[offset] + rgba[offset + 1] + rgba[offset + 2]) / 3,
        );
      }
      return signature;
    } catch {
      unavailable = true;
      return null;
    }
  };
}

function videoFramesDiffer(
  previous: Uint8Array,
  current: Uint8Array,
): boolean {
  if (previous.length !== current.length) return true;
  let totalDifference = 0;
  for (let index = 0; index < previous.length; index += 1) {
    totalDifference += Math.abs(previous[index] - current[index]);
  }
  return totalDifference / previous.length >= 0.75;
}

/**
 * `video.play()` may resolve even when WebKitGTK presents one decoded frame and
 * then stalls. Treat playback as supported only after observing at least three
 * actual frames through the browser's frame API, playback quality counters, or
 * sampled video pixels. Current-time movement is only the final fallback.
 */
function waitForRenderedVideoMotion(
  video: HTMLVideoElement,
  shouldContinue: () => boolean,
): Promise<void> {
  const observable = video as ObservableVideo;
  const initialFrameCount = getPresentedFrameCount(observable);
  const initialTime = video.currentTime;
  const sampleFrame = createVideoFrameSampler(video);

  return new Promise((resolve, reject) => {
    let settled = false;
    let frameCallbackHandle: number | null = null;
    let firstCallbackTime: number | null = null;
    let callbackAdvances = 0;
    let previousSignature: Uint8Array | null = null;
    let sampledChanges = 0;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearInterval(poll);
      window.clearTimeout(timeout);
      video.removeEventListener("error", handleError);
      if (frameCallbackHandle != null) {
        observable.cancelVideoFrameCallback?.(frameCallbackHandle);
      }
      if (error) reject(error);
      else resolve();
    };
    const handleError = () =>
      finish(new Error("Live Photo frames could not be decoded"));
    const handleFrame = (_now: number, metadata: { mediaTime: number }) => {
      if (settled) return;
      if (!shouldContinue()) {
        finish(new Error("Live Photo playback was cancelled"));
        return;
      }
      if (firstCallbackTime == null) {
        firstCallbackTime = metadata.mediaTime;
      } else if (Math.abs(metadata.mediaTime - firstCallbackTime) >= 0.02) {
        firstCallbackTime = metadata.mediaTime;
        callbackAdvances += 1;
        if (callbackAdvances >= 2) {
          finish();
          return;
        }
      }
      frameCallbackHandle = observable.requestVideoFrameCallback?.(handleFrame) ?? null;
    };

    if (observable.requestVideoFrameCallback) {
      frameCallbackHandle = observable.requestVideoFrameCallback(handleFrame);
    }

    const poll = window.setInterval(() => {
      if (!shouldContinue()) {
        finish(new Error("Live Photo playback was cancelled"));
        return;
      }

      const frameCount = getPresentedFrameCount(observable);
      if (
        initialFrameCount != null &&
        frameCount != null &&
        frameCount - initialFrameCount >= 2
      ) {
        finish();
        return;
      }

      const signature = sampleFrame();
      if (signature) {
        if (
          previousSignature &&
          videoFramesDiffer(previousSignature, signature)
        ) {
          sampledChanges += 1;
        }
        previousSignature = signature;
        if (sampledChanges >= 2) finish();
        return;
      }

      if (
        !observable.requestVideoFrameCallback &&
        initialFrameCount == null &&
        video.readyState >= 3 &&
        Math.abs(video.currentTime - initialTime) >= 0.2
      ) {
        finish();
      }
    }, LIVE_PROGRESS_POLL_MS / 2);
    const timeout = window.setTimeout(
      () => finish(new Error("Live Photo motion did not render")),
      LIVE_RENDER_PROBE_TIMEOUT_MS,
    );

    video.addEventListener("error", handleError, { once: true });
  });
}

export const LIVE_PHOTO_LINUX_MESSAGE =
  "Live Photo motion is not supported on Linux.";

export const LIVE_PHOTO_UNSUPPORTED_MESSAGE =
  "Live Photo motion is not supported on this device.";

export function getLivePlaybackError(desktopOs: string): string {
  // Rust's `get_platform_info` is the source of truth, so a known value wins
  // outright. The user-agent sniff is only the pre-IPC fallback for the frame
  // before that response lands (and it must never override a known non-Linux
  // host: every WebView UA string is Linux-ish under test/jsdom).
  const isLinux = desktopOs
    ? desktopOs === "linux"
    : inferLinuxFromUserAgent();
  return isLinux ? LIVE_PHOTO_LINUX_MESSAGE : LIVE_PHOTO_UNSUPPORTED_MESSAGE;
}

function inferLinuxFromUserAgent(): boolean {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent.toLowerCase();
  return userAgent.includes("linux") && !userAgent.includes("android");
}

interface DesktopMediaCapabilities {
  os: string;
  supportsLivePhotoMotion: boolean | null;
}

function inferDesktopMediaCapabilities(): DesktopMediaCapabilities {
  if (typeof navigator === "undefined") {
    return { os: "", supportsLivePhotoMotion: null };
  }
  const userAgent = navigator.userAgent.toLowerCase();
  if (inferLinuxFromUserAgent()) {
    return { os: "linux", supportsLivePhotoMotion: false };
  }
  if (userAgent.includes("mac os")) {
    return { os: "macos", supportsLivePhotoMotion: true };
  }
  if (userAgent.includes("windows")) {
    return { os: "windows", supportsLivePhotoMotion: true };
  }
  return { os: "", supportsLivePhotoMotion: null };
}

/**
 * The unsupported tooltip is portalled to `document.body`, so it sits OUTSIDE
 * the viewer dialog's stacking context and must out-rank the viewer overlay by
 * hand. It previously used a flat `z-[200]` while the overlay renders at 999,
 * so on Linux the LIVE badge went disabled on hover with no explanation
 * anywhere on screen: the tooltip was rendering behind the full-screen viewer.
 */
export const LIVE_PHOTO_TOOLTIP_Z_INDEX = FILE_VIEWER_OVERLAY_Z_INDEX + 1;

export const LivePhotoToggle: React.FC<{
  playing: boolean;
  error: string | null;
  onClick: () => void;
}> = ({ playing, error, onClick }) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipId = React.useId();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ left: 0, top: 0 });

  const updateTooltipPosition = useCallback(() => {
    if (!buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const tooltipMaxWidth = 256;
    setTooltipPosition({
      left: Math.min(
        Math.max(8, rect.left),
        Math.max(8, window.innerWidth - tooltipMaxWidth - 8),
      ),
      top: rect.bottom + 6,
    });
  }, []);

  const showUnsupportedTooltip = useCallback(() => {
    if (!error) return;
    updateTooltipPosition();
    setTooltipOpen(true);
  }, [error, updateTooltipPosition]);

  const hideUnsupportedTooltip = useCallback(() => {
    // Keyboard focus outlives the pointer leaving, so a focused badge keeps
    // its explanation until blur.
    if (document.activeElement === buttonRef.current) return;
    setTooltipOpen(false);
  }, []);

  useEffect(() => {
    if (!error) {
      setTooltipOpen(false);
      return;
    }

    const button = buttonRef.current;
    if (
      button &&
      (button.matches(":hover") || document.activeElement === button)
    ) {
      showUnsupportedTooltip();
    }
  }, [error, showUnsupportedTooltip]);

  useEffect(() => {
    if (!error || !tooltipOpen) return;

    updateTooltipPosition();
    window.addEventListener("resize", updateTooltipPosition);
    window.addEventListener("scroll", updateTooltipPosition, true);
    return () => {
      window.removeEventListener("resize", updateTooltipPosition);
      window.removeEventListener("scroll", updateTooltipPosition, true);
    };
  }, [error, tooltipOpen, updateTooltipPosition]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (error) {
            buttonRef.current?.focus();
            showUnsupportedTooltip();
            return;
          }
          onClick();
        }}
        // Hover is wired on BOTH event families as belt and braces. The
        // disabled LOOK (`cursor-not-allowed`, the dimmed fill) is pure CSS
        // `:hover`, so it paints wherever the cursor lands; the explanation is
        // JS-driven and so is only as good as the events the host WebView
        // delivers. Pointer Events are enough on the WebViews we have checked
        // (macOS/Windows and WebKitGTK on Linux), so this is redundancy, not a
        // fix for a known gap. Both firing is harmless: opening is idempotent.
        onPointerEnter={showUnsupportedTooltip}
        onMouseEnter={showUnsupportedTooltip}
        onPointerLeave={hideUnsupportedTooltip}
        onMouseLeave={hideUnsupportedTooltip}
        onFocus={showUnsupportedTooltip}
        onBlur={() => setTooltipOpen(false)}
        // Native last-resort fallback: it needs neither React events nor the
        // portalled element's stacking to survive, so the reason stays
        // reachable even if the rendered tooltip is somehow suppressed. It is
        // dropped the moment the real tooltip opens, so the two never stack up
        // on platforms where hover works.
        title={error && !tooltipOpen ? error : undefined}
        aria-disabled={!!error}
        aria-describedby={error && tooltipOpen ? tooltipId : undefined}
        aria-label={error ?? (playing ? "Pause Live Photo" : "Play Live Photo")}
        aria-pressed={playing}
        className={cn(
          "absolute left-3 top-3 z-10 flex items-center gap-[5px] rounded-full bg-[#0A0A0A]/65 px-[10px] py-[6px] text-xs font-semibold tracking-[0.3px] text-white backdrop-blur-sm transition-colors hover:bg-[#0A0A0A]/80",
          error && "cursor-not-allowed opacity-55 hover:bg-[#0A0A0A]/65",
        )}
      >
        {error ? (
          <Info className="size-3" />
        ) : playing ? (
          <Pause className="size-3 fill-current" />
        ) : (
          <Play className="size-3 fill-current" />
        )}
        LIVE
      </button>
      {error && tooltipOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              id={tooltipId}
              role="tooltip"
              style={{ ...tooltipPosition, zIndex: LIVE_PHOTO_TOOLTIP_Z_INDEX }}
              className="pointer-events-none fixed max-w-64 rounded-lg bg-[#0A0A0A]/85 px-2.5 py-1.5 text-xs font-medium leading-snug text-white shadow-lg backdrop-blur-sm"
            >
              {error}
            </div>,
            document.body,
          )
        : null}
    </>
  );
};

const ImageError: React.FC<{
  message: string;
  file: FormattedUserFile;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string,
  ) => void;
}> = ({ message, file, handleFileDownload }) => (
  <PreviewFallback
    title="Failed to load image"
    description={message}
    file={file}
    handleFileDownload={handleFileDownload}
  />
);

/**
 * Image renderer body for the unified viewer.
 *
 * Owns everything image-specific and nothing viewer-specific: the HEIC → JPEG
 * adapter and the Hippius Live still/motion pairing (both prepared by Rust via
 * `usePreparedImagePreview`), the contained-size framing, and the Live Photo
 * play toggle with its Linux capability gate. `UnifiedMediaDialog` supplies the
 * surrounding chrome.
 */
const ImagePreviewBody: React.FC<{
  file: FormattedUserFile;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string,
  ) => void;
}> = ({ file, handleFileDownload }) => {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [livePlaying, setLivePlaying] = useState(false);
  const [livePlaybackError, setLivePlaybackError] = useState<string | null>(
    null,
  );
  const [desktopMediaCapabilities, setDesktopMediaCapabilities] =
    useState<DesktopMediaCapabilities>(inferDesktopMediaCapabilities);
  const [naturalImageSize, setNaturalImageSize] = useState<MediaSize | null>(
    null,
  );
  const [previewFrameSize, setPreviewFrameSize] = useState<MediaSize | null>(
    null,
  );
  const mediaAreaRef = useRef<HTMLDivElement>(null);
  const imageElementRef = useRef<HTMLImageElement>(null);
  const liveVideoRef = useRef<HTMLVideoElement>(null);
  const livePlaybackWantedRef = useRef(false);
  const livePlaybackRunRef = useRef(0);
  const liveRestartingRef = useRef(false);
  const liveWatchdogTimerRef = useRef<number | null>(null);
  const liveWatchdogFrameRef = useRef<number | null>(null);

  const stopLivePlaybackWatchdog = useCallback(() => {
    if (liveWatchdogTimerRef.current != null) {
      window.clearInterval(liveWatchdogTimerRef.current);
      liveWatchdogTimerRef.current = null;
    }
    const video = liveVideoRef.current as ObservableVideo | null;
    if (video && liveWatchdogFrameRef.current != null) {
      video.cancelVideoFrameCallback?.(liveWatchdogFrameRef.current);
    }
    liveWatchdogFrameRef.current = null;
  }, []);
  // Resolves to a local URL for synced files, or downloads + decrypts a
  // cloud-only file on demand (sidebar-search results that aren't on disk).
  const {
    url: resolvedUrl,
    localPath,
    isLoading: resolving,
    error: resolveError,
  } = useViewableFileUrl(file);
  const {
    imageUrl,
    liveVideoUrl,
    isPreparing,
    error: prepareError,
  } = usePreparedImagePreview(resolvedUrl, localPath, file?.name ?? "");

  useEffect(() => {
    let cancelled = false;
    void invoke<{
      os: string;
      supportsLivePhotoMotion: boolean;
    }>("get_platform_info")
      .then((info) => {
        if (!cancelled) {
          setDesktopMediaCapabilities({
            os: info.os,
            supportsLivePhotoMotion: info.supportsLivePhotoMotion,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopMediaCapabilities((current) => ({
            ...current,
            supportsLivePhotoMotion:
              current.supportsLivePhotoMotion ?? current.os !== "linux",
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Adopt an image the browser has finished decoding.
   *
   * Shared by `onLoad` and the cache sweep below so both paths produce exactly
   * the same state; when this was inline on the element, only the event path
   * existed and a cached image had no way in.
   */
  const adoptLoadedImage = useCallback((element: HTMLImageElement) => {
    const naturalSize = {
      width: element.naturalWidth,
      height: element.naturalHeight,
    };
    setNaturalImageSize(naturalSize);
    if (mediaAreaRef.current) {
      setPreviewFrameSize(
        containedSize(naturalSize, {
          width: mediaAreaRef.current.clientWidth,
          height: mediaAreaRef.current.clientHeight,
        }),
      );
    }
    setImageLoaded(true);
    setImageError(null);
  }, []);

  // Reset the <img> load state whenever the resolved URL changes (new file in
  // the strip, or a just-finished cloud decrypt).
  useEffect(() => {
    stopLivePlaybackWatchdog();
    setImageLoaded(false);
    setImageError(null);
    setLivePlaying(false);
    setLivePlaybackError(null);
    setNaturalImageSize(null);
    setPreviewFrameSize(null);
    livePlaybackWantedRef.current = false;
    livePlaybackRunRef.current += 1;
    liveRestartingRef.current = false;
    return stopLivePlaybackWatchdog;
  }, [imageUrl, liveVideoUrl, stopLivePlaybackWatchdog]);

  // `imageLoaded` gates the photo's OPACITY, not just the spinner, and only
  // `onLoad` ever sets it — so an image the WebView had already cached stays
  // invisible forever: it completes while React is still attaching props, and
  // the `load` event is dispatched with no handler to hear it. That is the
  // common case rather than the rare one, because the thumbnail rail serves a
  // local file from the SAME full-size `convertFileSrc(source)` url, so the
  // file the user clicks is essentially guaranteed to be in cache already.
  //
  // Declared after the reset effect so it settles the state for this url last;
  // it shares that effect's deps so every reset is re-evaluated here.
  useEffect(() => {
    const element = imageElementRef.current;
    if (!element || !imageUrl || !element.complete) return;
    // `complete` is true for a decode FAILURE too. A zero intrinsic width is
    // what separates them, and without the check adopting blindly would swap
    // the endless spinner for an equally blank frame that claims success.
    if (element.naturalWidth === 0) {
      setImageError("Failed to load image");
      return;
    }
    adoptLoadedImage(element);
  }, [imageUrl, liveVideoUrl, adoptLoadedImage]);

  useEffect(() => {
    const area = mediaAreaRef.current;
    if (!area || !naturalImageSize) return;

    const updateSize = () => {
      setPreviewFrameSize(
        containedSize(naturalImageSize, {
          width: area.clientWidth,
          height: area.clientHeight,
        }),
      );
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(area);
    return () => observer.disconnect();
  }, [naturalImageSize]);

  // A failed decrypt/download takes precedence over an <img> load failure.
  const displayError = resolveError ?? prepareError ?? imageError;
  const platformLivePlaybackError =
    desktopMediaCapabilities.supportsLivePhotoMotion === false
      ? getLivePlaybackError(desktopMediaCapabilities.os)
      : null;
  const liveToggleError = platformLivePlaybackError ?? livePlaybackError;

  const markLivePlaybackUnsupported = useCallback(() => {
    stopLivePlaybackWatchdog();
    livePlaybackWantedRef.current = false;
    livePlaybackRunRef.current += 1;
    liveRestartingRef.current = false;
    liveVideoRef.current?.pause();
    setLivePlaying(false);
    setLivePlaybackError(getLivePlaybackError(desktopMediaCapabilities.os));
  }, [desktopMediaCapabilities.os, stopLivePlaybackWatchdog]);

  const startLivePlaybackWatchdog = useCallback(
    (video: HTMLVideoElement) => {
      stopLivePlaybackWatchdog();
      const observable = video as ObservableVideo;
      const sampleFrame = createVideoFrameSampler(video);
      let lastEvidenceAt = performance.now();
      let lastFrameCount = getPresentedFrameCount(observable);
      let lastCallbackTime: number | null = null;
      let lastSignature: Uint8Array | null = null;
      let lastCurrentTime = video.currentTime;

      const recordEvidence = () => {
        lastEvidenceAt = performance.now();
      };
      const handleFrame = (_now: number, metadata: { mediaTime: number }) => {
        if (!livePlaybackWantedRef.current) return;
        if (
          lastCallbackTime == null ||
          Math.abs(metadata.mediaTime - lastCallbackTime) >= 0.02
        ) {
          lastCallbackTime = metadata.mediaTime;
          recordEvidence();
        }
        liveWatchdogFrameRef.current =
          observable.requestVideoFrameCallback?.(handleFrame) ?? null;
      };
      if (observable.requestVideoFrameCallback) {
        liveWatchdogFrameRef.current =
          observable.requestVideoFrameCallback(handleFrame);
      }

      liveWatchdogTimerRef.current = window.setInterval(() => {
        if (!livePlaybackWantedRef.current) return;
        if (liveRestartingRef.current || video.ended) {
          recordEvidence();
          return;
        }

        const frameCount = getPresentedFrameCount(observable);
        if (
          frameCount != null &&
          (lastFrameCount == null || frameCount > lastFrameCount)
        ) {
          lastFrameCount = frameCount;
          recordEvidence();
        }

        const signature = sampleFrame();
        if (
          signature &&
          lastSignature &&
          videoFramesDiffer(lastSignature, signature)
        ) {
          recordEvidence();
        }
        if (signature) lastSignature = signature;

        if (
          !observable.requestVideoFrameCallback &&
          frameCount == null &&
          !signature &&
          Math.abs(video.currentTime - lastCurrentTime) >= 0.04
        ) {
          recordEvidence();
        }
        lastCurrentTime = video.currentTime;

        if (performance.now() - lastEvidenceAt >= LIVE_STALL_TIMEOUT_MS) {
          markLivePlaybackUnsupported();
        }
      }, LIVE_PROGRESS_POLL_MS);
    },
    [markLivePlaybackUnsupported, stopLivePlaybackWatchdog],
  );

  const playLiveFromStart = useCallback(async () => {
    const video = liveVideoRef.current;
    if (
      !video ||
      desktopMediaCapabilities.supportsLivePhotoMotion !== true ||
      livePlaybackError
    ) {
      return;
    }

    if (liveRestartingRef.current) return;
    liveRestartingRef.current = true;
    const run = ++livePlaybackRunRef.current;

    try {
      video.pause();
      await waitForVideoMetadata(video);
      if (
        run !== livePlaybackRunRef.current ||
        !livePlaybackWantedRef.current
      ) {
        return;
      }
      video.currentTime = 0;
      await video.play();
      await waitForRenderedVideoMotion(
        video,
        () =>
          run === livePlaybackRunRef.current &&
          livePlaybackWantedRef.current,
      );
      if (
        run !== livePlaybackRunRef.current ||
        !livePlaybackWantedRef.current
      ) {
        video.pause();
        return;
      }
      setLivePlaying(true);
      startLivePlaybackWatchdog(video);
    } catch {
      if (run === livePlaybackRunRef.current) {
        markLivePlaybackUnsupported();
      }
    } finally {
      if (run === livePlaybackRunRef.current) {
        liveRestartingRef.current = false;
      }
    }
  }, [
    livePlaybackError,
    markLivePlaybackUnsupported,
    startLivePlaybackWatchdog,
    desktopMediaCapabilities.supportsLivePhotoMotion,
  ]);

  const handleLiveToggle = () => {
    const video = liveVideoRef.current;
    if (
      !video ||
      desktopMediaCapabilities.supportsLivePhotoMotion !== true ||
      livePlaybackError
    ) {
      return;
    }

    if (livePlaybackWantedRef.current) {
      livePlaybackWantedRef.current = false;
      livePlaybackRunRef.current += 1;
      liveRestartingRef.current = false;
      stopLivePlaybackWatchdog();
      video.pause();
      if (video.readyState >= 1) video.currentTime = 0;
      setLivePlaying(false);
      return;
    }

    livePlaybackWantedRef.current = true;
    void playLiveFromStart();
  };

  return (
    <PreviewSurface className="items-center justify-center">
      <div className="relative w-full h-full min-h-0 min-w-0 flex items-center justify-center">
        {!imageLoaded &&
          !displayError &&
          (resolvedUrl || resolving || isPreparing) && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Loader2 className="size-6 text-primary-50 animate-spin" />
          </div>
        )}

        {!displayError && imageUrl && (
          <motion.div
            ref={mediaAreaRef}
            key={file.actualFileName || file.name}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{
              opacity: imageLoaded ? 1 : 0,
              scale: imageLoaded ? 1 : 1.0,
            }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="relative w-full h-full min-h-0 min-w-0 flex items-center justify-center"
          >
            <div
              style={
                previewFrameSize
                  ? {
                      width: previewFrameSize.width,
                      height: previewFrameSize.height,
                    }
                  : undefined
              }
              className={cn(
                "relative flex max-h-full max-w-full overflow-hidden rounded-[8px]",
                "shadow-[0_14px_31px_rgba(0,0,0,0.06),0_56px_56px_rgba(0,0,0,0.05)]",
              )}
            >
              <img
                key={imageUrl}
                ref={imageElementRef}
                onLoad={(event) => adoptLoadedImage(event.currentTarget)}
                onError={() => {
                  setImageLoaded(false);
                  setImageError("Failed to load image");
                }}
                src={imageUrl}
                alt={file.name}
                className={cn(
                  previewFrameSize
                    ? "size-full"
                    : "max-h-full max-w-full h-auto w-auto",
                  "object-contain duration-300 opacity-0",
                  imageLoaded && "opacity-100",
                )}
              />

              {liveVideoUrl &&
                imageLoaded &&
                desktopMediaCapabilities.supportsLivePhotoMotion !== null && (
                <>
                  {desktopMediaCapabilities.supportsLivePhotoMotion ? (
                    <video
                      ref={liveVideoRef}
                      src={liveVideoUrl}
                      playsInline
                      preload="metadata"
                      onEnded={() => {
                        if (livePlaybackWantedRef.current) {
                          void playLiveFromStart();
                        } else {
                          setLivePlaying(false);
                        }
                      }}
                      onError={markLivePlaybackUnsupported}
                      aria-label={`${file.name} Live Photo motion`}
                      className={cn(
                        "pointer-events-none absolute inset-0 size-full object-contain opacity-0 transition-opacity duration-150",
                        livePlaying && "opacity-100",
                      )}
                    />
                  ) : null}
                  <LivePhotoToggle
                    playing={livePlaying}
                    error={liveToggleError}
                    onClick={handleLiveToggle}
                  />
                </>
              )}
            </div>
          </motion.div>
        )}

        {displayError && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
          >
            <ImageError
              handleFileDownload={handleFileDownload}
              message={displayError}
              file={file}
            />
          </motion.div>
        )}
      </div>
    </PreviewSurface>
  );
};

export default ImagePreviewBody;
