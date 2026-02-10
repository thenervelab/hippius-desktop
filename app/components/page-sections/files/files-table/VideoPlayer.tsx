import React, { useEffect, useRef, useState, useCallback } from "react";
import { MediaPlayer, MediaProvider } from "@vidstack/react";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import {
  defaultLayoutIcons,
  DefaultVideoLayout
} from "@vidstack/react/player/layouts/default";
import { SUPPORTED_VIDEO_MIME_TYPES } from "@/lib/constants/supportedMimeTypes";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import VideoPlayerError from "./VideoPlayerError";

export async function toBlobUrl(url: string) {
  const res = await fetch(url);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// Check if running in Tauri
const isTauri = typeof window !== "undefined" && "__TAURI__" in window;

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
  isFromIpfs = false,
  isFromLocal = false,
  file,
  handleFileDownload
}) => {
  const [error, setError] = useState<string>("");
  const [playUrl, setPlayUrl] = useState<string>("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [reloadKey, setReloadKey] = useState<number>(0);
  const timeoutRef = useRef<number | undefined>(undefined);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const LOAD_TIMEOUT = 120_000;

  const ua =
    typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";
  const isFirefox = ua.includes("firefox");

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

    if (isFirefox && ["mkv", "3gp"].includes(fileFormat)) {
      setError("This video format isn't supported in Firefox");
      return;
    }
    timeoutRef.current = window.setTimeout(() => {
      setError("Video is taking too long to load");
    }, LOAD_TIMEOUT);
    return clearLoadTimer;
  }, [videoUrl, fileFormat, isFirefox, reloadKey]);

  useEffect(() => {
    let revoke: string | null = null;

    (async () => {
      if (!videoUrl || videoUrl.trim() === "") {
        setPlayUrl("");
        return;
      }

      if (isFromIpfs || isFromLocal) {
        setPlayUrl(videoUrl);
        return;
      }

      try {
        const blobUrl = await toBlobUrl(videoUrl);
        revoke = blobUrl;
        setPlayUrl(blobUrl);
      } catch (error) {
        console.error('VideoPlayer - Failed to create blob URL:', error);
        setError("Failed to load video file");
      }
    })();

    return () => {
      if (revoke) {
        URL.revokeObjectURL(revoke);
      }
    };
  }, [videoUrl, isFromIpfs, isFromLocal]);
  const finalPlayUrl = playUrl || videoUrl;

  // Don't render MediaPlayer if no URL is available
  if (!finalPlayUrl || finalPlayUrl.trim() === "") {
    return (
      <div className="flex items-center justify-center h-full text-white">
        <div className="text-center">
          <div className="text-lg font-medium mb-2">Loading video...</div>
          <div className="text-sm text-gray-300">
            {isFromIpfs ? "Resolving IPFS video URL..." : "Preparing video URL"}
          </div>
        </div>
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
        src={{
          src: finalPlayUrl,
          type: SUPPORTED_VIDEO_MIME_TYPES[
            fileFormat
          ] as import("@vidstack/react").VideoMimeType
        }}
        playsInline
        onLoadedData={() => {
          clearLoadTimer();
        }}
        onError={(error) => {
          console.error('VideoPlayer - Media error:', error, 'URL:', finalPlayUrl, 'isFromIpfs:', isFromIpfs);
          clearLoadTimer();
          setError("Unable to play this video");
        }}
        onCanPlay={() => {
          console.log('VideoPlayer - Video can play:', finalPlayUrl);
        }}
        onLoadStart={() => {
          console.log('VideoPlayer - Video load started:', finalPlayUrl);
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
