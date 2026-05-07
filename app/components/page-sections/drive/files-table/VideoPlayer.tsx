import React, { useEffect, useRef, useState, useCallback } from "react";
import { MediaPlayer, MediaProvider } from "@vidstack/react";
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

// Platform info loaded from Rust (replaces deprecated navigator.platform)
let _isLinux = false;
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
  const LOAD_TIMEOUT = 120_000;

  const clearLoadTimer = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
  };

  const handleReload = () => {
    setError("");
    clearLoadTimer();
    setReloadKey((prev) => prev + 1);
  };

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
    return clearLoadTimer;
  }, [videoUrl, fileFormat, reloadKey]);

  // Don't render MediaPlayer if no URL is available
  if (!videoUrl || videoUrl.trim() === "") {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-50" />
      </div>
    );
  }

  // Formats where Chromium natively understands the container well.
  // For these we provide an explicit MIME type hint so vidstack picks the
  // correct decoder immediately. For everything else (mov, mkv, 3gp, …) we
  // let the player auto-detect by passing just the URL string.
  const nativeFormats: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    ogg: "video/ogg",
  };

  // .mov files are usually H.264 inside a QuickTime container – Chromium can
  // play those if we tell it the MIME is video/mp4.
  const movedToMp4 = fileFormat === "mov";
  const mimeType = movedToMp4
    ? "video/mp4"
    : nativeFormats[fileFormat] ?? undefined;

  // Stream the URL directly — the browser handles HTTP range-request
  // streaming natively for remote URLs, and Tauri's asset:// protocol
  // serves local files.
  const srcProp: import("@vidstack/react").MediaSrc = mimeType
    ? { src: videoUrl, type: mimeType as import("@vidstack/react").VideoMimeType }
    : videoUrl;

  // On Linux, skip the media player entirely and show the fallback UI.
  // WebKitGTK lacks codecs for most video formats.
  if (isTauri && _isLinux) {
    return (
      <div className="relative w-full h-full bg-black">
        <VideoPlayerError
          message="Video playback is not supported in the built-in player on Linux."
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
        className="w-full h-full [--media-buffering-size:48px]"
        load="eager"
        autoPlay
        src={srcProp}
        playsInline
        onLoadedData={() => {
          clearLoadTimer();
        }}
        onError={(error) => {
          console.error('VideoPlayer - Media error:', error, 'URL:', videoUrl, 'format:', fileFormat, 'mime:', mimeType);
          clearLoadTimer();
          setError(
            "This video format (." + fileFormat + ") can't be played in the built-in player."
          );
        }}
        onCanPlay={() => {
          console.log('VideoPlayer - Video can play:', videoUrl);
        }}
        onLoadStart={() => {
          console.log('VideoPlayer - Video load started:', videoUrl, 'format:', fileFormat, 'mime:', mimeType);
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
