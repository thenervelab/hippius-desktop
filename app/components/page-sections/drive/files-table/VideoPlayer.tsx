import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import {
  MediaPlayer,
  MediaProvider,
  type MediaPlayerInstance,
} from "@vidstack/react";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import {
  defaultLayoutIcons,
  DefaultVideoLayout
} from "@vidstack/react/player/layouts/default";
import { isTauri as isTauriRuntime } from "@tauri-apps/api/core";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import VideoPlayerError from "./VideoPlayerError";

// Check if running in Tauri (uses window.isTauri injected by the Tauri runtime,
// which is available regardless of the `withGlobalTauri` setting)
const isTauri = isTauriRuntime();

// Synchronous Linux detection — must be available on the FIRST render so
// the short-circuit below can render the system-player fallback without
// flashing a hanging vidstack player. UA-sniffing is unreliable in
// general but reliable enough here: WebKitGTK on Linux always emits an
// "X11; Linux" or "Wayland; Linux" UA, while WKWebView (macOS) and
// WebView2 (Windows) never do.
const _isLinuxFromUA =
  typeof navigator !== "undefined" && /linux/i.test(navigator.userAgent);

// Platform info loaded from Rust (replaces deprecated navigator.platform).
// `_isLinux` is initialised from the UA above and then refined by the
// authoritative Rust answer once it arrives; in practice both agree.
let _isLinux = isTauri && _isLinuxFromUA;
let _unsupportedEngine = false;
if (isTauri) {
  import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke<{ os: string; supportsMkv: boolean }>("get_platform_info").then((info) => {
      _isLinux = info.os === "linux";
      _unsupportedEngine = !info.supportsMkv;
    }).catch(() => {})
  );
}

// Container formats that WKWebView / Safari fundamentally cannot play
const UNSUPPORTED_FORMATS = ["mkv", "3gp"];

// MIME hints by extension. Mirrors `SUPPORTED_VIDEO_MIME_TYPES` in the
// hippius-console VideoPlayer so the same uploaded videos that play
// there also play here. Always providing a `type` to vidstack helps it
// pick the right decoder without sniffing the URL — particularly
// important for the Tauri `asset://` protocol where browsers can't
// reliably guess the MIME from the response.
const SUPPORTED_VIDEO_MIME_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogg: "video/ogg",
  ogv: "video/ogg",
  // Real .mov MIME — Chromium / WebKit play H.264-in-QuickTime fine when
  // told it's `video/quicktime`. Lying about it as `video/mp4` can
  // confuse some decoders.
  mov: "video/quicktime",
  "3gp": "video/3gpp",
  // mkv generally isn't natively decodable; the hint lets the player
  // attempt playback rather than reject the URL outright.
  mkv: "video/webm",
};

// Helper functions for Tauri window fullscreen
async function setTauriFullscreen(fullscreen: boolean) {
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const appWindow = getCurrentWindow();
    await appWindow.setFullscreen(fullscreen);
  } catch (error) {
    console.error("Failed to set Tauri fullscreen:", error);
  }
}

interface VideoPlayerProps {
  videoUrl: string;
  fileFormat: string;
  file?: FormattedUserFile;
  isFromIpfs?: boolean;
  isFromLocal?: boolean;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string
  ) => void;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({
  videoUrl,
  fileFormat,
  file,
  handleFileDownload
}) => {
  const [error, setError] = useState<string>("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [reloadKey, setReloadKey] = useState<number>(0);
  const timeoutRef = useRef<number | undefined>(undefined);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<MediaPlayerInstance>(null);
  // Stall-watch state, mirroring the console player. We poll the
  // underlying <video> element's buffered ranges while it's in the
  // `waiting` state and nudge / soft-reload it if no progress is made.
  const stallTimerRef = useRef<number | null>(null);
  const stallStartedAtRef = useRef<number | null>(null);

  // 120s everywhere, including Linux: a shorter ceiling trips on
  // perfectly healthy videos that simply take a moment to load from
  // disk or the asset:// protocol. Linux installations without H.264
  // codecs surface an `onError` from the underlying media element
  // instead, so they don't need a fast-fail timeout.
  const LOAD_TIMEOUT = 120_000;

  const clearLoadTimer = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
  };

  // Detect a "playback stalled" condition: <0.3s buffered ahead of the
  // playhead for >3s gets a tiny seek nudge, >6s triggers a soft
  // reload. Same heuristic as the console player.
  const stopStallWatch = useCallback(() => {
    if (stallTimerRef.current) {
      clearInterval(stallTimerRef.current);
      stallTimerRef.current = null;
    }
    stallStartedAtRef.current = null;
  }, []);

  const handleReload = useCallback(() => {
    setError("");
    clearLoadTimer();
    stopStallWatch();
    setReloadKey((prev) => prev + 1);
  }, [stopStallWatch]);

  const startStallWatch = useCallback(() => {
    if (stallTimerRef.current) return;
    stallStartedAtRef.current = Date.now();
    stallTimerRef.current = window.setInterval(() => {
      const media = playerRef.current?.el?.querySelector("video") as
        | HTMLMediaElement
        | undefined;
      if (!media) return;

      const ct = media.currentTime;
      const buf = media.buffered;
      let ahead = 0;
      for (let i = 0; i < buf.length; i++) {
        const start = buf.start(i);
        const end = buf.end(i);
        if (ct >= start && ct <= end) {
          ahead = end - ct;
          break;
        }
      }
      const stalledMs = stallStartedAtRef.current
        ? Date.now() - stallStartedAtRef.current
        : 0;

      if (ahead < 0.3 && stalledMs > 3000 && stalledMs <= 6000) {
        try {
          media.currentTime = Math.max(0, ct + 0.01);
        } catch {
          // ignore – seeking can throw on unseekable streams
        }
      } else if (ahead < 0.3 && stalledMs > 6000) {
        stopStallWatch();
        handleReload();
      }
    }, 750) as unknown as number;
  }, [handleReload, stopStallWatch]);

  // Enter fullscreen - both Tauri window and CSS
  const enterFullscreen = useCallback(async () => {
    setIsFullscreen(true);
    await setTauriFullscreen(true);
  }, []);

  // Exit fullscreen - both Tauri window and CSS
  const exitFullscreen = useCallback(async () => {
    setIsFullscreen(false);
    await setTauriFullscreen(false);
  }, []);

  // Toggle fullscreen
  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen) {
      await exitFullscreen();
    } else {
      await enterFullscreen();
    }
  }, [isFullscreen, enterFullscreen, exitFullscreen]);

  // Exit fullscreen on Escape key
  useEffect(() => {
    if (!isFullscreen) return;

    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        await exitFullscreen();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isFullscreen, exitFullscreen]);

  // Intercept fullscreen button clicks in Tauri
  useEffect(() => {
    if (!isTauri || !playerContainerRef.current) return;

    const container = playerContainerRef.current;

    const handleClick = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Check if the clicked element is a fullscreen button
      const isFullscreenButton =
        target.closest('[data-media-fullscreen-button]') ||
        target.closest('button[aria-label*="ullscreen"]') ||
        target.closest('.vds-fullscreen-button') ||
        target.closest('[class*="fullscreen"]');

      if (isFullscreenButton) {
        e.preventDefault();
        e.stopPropagation();
        await toggleFullscreen();
      }
    };

    // Handle double-click on video for fullscreen toggle
    const handleDoubleClick = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Check if double-clicked on video area (not controls)
      const isVideoArea =
        target.tagName === 'VIDEO' ||
        target.closest('[data-media-provider]');

      const isControlsArea = target.closest('.vds-controls');

      if (isVideoArea && !isControlsArea) {
        e.preventDefault();
        e.stopPropagation();
        await toggleFullscreen();
      }
    };

    container.addEventListener('click', handleClick, true);
    container.addEventListener('dblclick', handleDoubleClick, true);

    return () => {
      container.removeEventListener('click', handleClick, true);
      container.removeEventListener('dblclick', handleDoubleClick, true);
    };
  }, [toggleFullscreen]);

  useEffect(() => {
    setError("");
    clearLoadTimer();
    stopStallWatch();

    // Don't start loading if no URL
    if (!videoUrl || videoUrl.trim() === "") {
      return;
    }

    // WKWebView (Tauri on macOS) cannot play MKV or 3GP containers,
    // nor HEVC/x265 codec.  Detect immediately so we don't spin for
    // 2 minutes before the timeout fires.
    if (_unsupportedEngine && UNSUPPORTED_FORMATS.includes(fileFormat)) {
      setError(
        "This video format (." +
          fileFormat +
          ") can't be played in the built-in player."
      );
      return;
    }

    timeoutRef.current = window.setTimeout(() => {
      setError("Video is taking too long to load");
    }, LOAD_TIMEOUT);
    // `stopStallWatch` is stable (useCallback([])) so it's intentionally
    // excluded from the dep list — adding it would change the dep-array
    // length under HMR and trip React's "deps array size changed"
    // assertion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      clearLoadTimer();
      stopStallWatch();
    };
  }, [videoUrl, fileFormat, reloadKey]);

  // Don't render MediaPlayer if no URL is available
  if (!videoUrl || videoUrl.trim() === "") {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-50" />
      </div>
    );
  }

  // Always pick a MIME hint from `SUPPORTED_VIDEO_MIME_TYPES`. Passing a
  // type to vidstack lets it select the correct provider engine without
  // sniffing the URL — important on the Tauri asset:// protocol where
  // sniffing isn't reliable. If the extension is unknown we still pass
  // the URL string and let the player attempt detection.
  const mimeType: string | undefined =
    SUPPORTED_VIDEO_MIME_TYPES[fileFormat?.toLowerCase()];

  // Stream the URL directly — the browser handles HTTP range-request
  // streaming natively for remote URLs, and Tauri's asset:// protocol
  // serves local files (with 206 range support in Tauri 2.0).
  const srcProp: import("@vidstack/react").MediaSrc = mimeType
    ? {
        src: videoUrl,
        type: mimeType as import("@vidstack/react").VideoMimeType,
      }
    : videoUrl;

  // Linux short-circuit: skip the in-app vidstack player and surface the
  // "Open with System Player" fallback immediately. WebKitGTK relies on
  // GStreamer for media decoding and most desktops ship without the
  // codecs the bundled player needs (notably H.264 / HEVC for MP4 +
  // MOV), so the built-in player otherwise hangs on a black frame until
  // the load timeout fires. Falling back early gives the user the
  // system-player + download buttons without the wait. macOS / Windows
  // (Chromium / WebView2 / WKWebView) continue through the normal
  // player path below. See `VideoPlayerError` for the fallback UI.
  if (isTauri && _isLinux) {
    return (
      <div
        ref={playerContainerRef}
        className="relative h-full w-full bg-black"
      >
        <VideoPlayerError
          message="Video playback isn't supported in the built-in player on Linux."
          file={file}
          handleFileDownload={handleFileDownload}
        />
      </div>
    );
  }

  return (
    <div
      ref={playerContainerRef}
      className={
        isFullscreen && isTauri
          ? "fixed inset-0 z-[99999] bg-black flex items-center justify-center"
          : "relative w-full h-full"
      }
    >
      {/* Exit fullscreen button - shows on hover in fullscreen mode */}
      {isFullscreen && isTauri && (
        <button
          onClick={exitFullscreen}
          className="absolute top-4 right-4 z-[100000] p-2 bg-black/60 hover:bg-black/80 rounded-full transition-all duration-200"
          aria-label="Exit fullscreen"
        >
          <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
      <MediaPlayer
        key={reloadKey}
        ref={playerRef}
        className="w-full h-full [--media-buffering-size:48px]"
        // `load="eager"` starts loading immediately; `preload="metadata"`
        // limits the first fetch to the moov atom + a small prefix so
        // the player can fire `loadedmetadata` quickly even on large
        // files that aren't fast-start-optimized.
        load="eager"
        preload="metadata"
        autoPlay
        src={srcProp}
        playsInline
        // Clear the load timer on any progress event so a video that
        // takes a moment to start (slow disk, large moov, asset://
        // range-request overhead) isn't killed prematurely. The console
        // player uses the same set; the stall watcher recovers from
        // mid-playback hangs.
        onLoadStart={() => {
          stopStallWatch();
        }}
        onLoadedMetadata={() => {
          clearLoadTimer();
        }}
        onLoadedData={() => {
          clearLoadTimer();
          stopStallWatch();
        }}
        onCanPlay={() => {
          clearLoadTimer();
          stopStallWatch();
        }}
        onWaiting={() => {
          startStallWatch();
        }}
        onPlaying={() => {
          clearLoadTimer();
          stopStallWatch();
        }}
        onError={(error) => {
          console.error(
            'VideoPlayer - Media error:',
            error,
            'URL:',
            videoUrl,
            'format:',
            fileFormat,
            'mime:',
            mimeType,
          );
          clearLoadTimer();
          stopStallWatch();
          setError(
            "This video format (." + fileFormat + ") can't be played in the built-in player.",
          );
        }}
      >
        <MediaProvider />
        {error ? (
          <VideoPlayerError
            message={error}
            file={file}
            onReload={handleReload}
            handleFileDownload={handleFileDownload}
          />
        ) : (
          <DefaultVideoLayout icons={defaultLayoutIcons} />
        )}
      </MediaPlayer>
    </div>
  );
};

export default VideoPlayer;
