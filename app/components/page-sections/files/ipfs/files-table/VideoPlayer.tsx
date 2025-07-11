// src/app/components/page-sections/files/ipfs/files-table/VideoPlayer.tsx
import React, { useEffect, useRef, useState } from "react";
import { MediaPlayer, MediaProvider } from "@vidstack/react";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import {
  defaultLayoutIcons,
  DefaultVideoLayout,
} from "@vidstack/react/player/layouts/default";
import { SUPPORTED_VIDEO_MIME_TYPES } from "@/lib/constants/supportedMimeTypes";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import VideoPlayerError from "./VideoPlayerError";

interface VideoPlayerProps {
  videoUrl: string;
  fileFormat: string;
  file?: FormattedUserIpfsFile;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({
  videoUrl,
  fileFormat,
  file,
}) => {
  const [error, setError] = useState<string>("");
  const [reloadKey, setReloadKey] = useState<number>(0);
  const timeoutRef = useRef<number | undefined>(undefined);
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

  useEffect(() => {
    setError("");
    clearLoadTimer();
    if (isFirefox && ["mkv", "3gp"].includes(fileFormat)) {
      setError("This video format isn't supported in Firefox");
      return;
    }
    timeoutRef.current = window.setTimeout(() => {
      setError("Video is taking too long to load");
    }, LOAD_TIMEOUT);
    return clearLoadTimer;
  }, [videoUrl, fileFormat, isFirefox, reloadKey]);

  return (
    <MediaPlayer
      key={reloadKey}
      className="relative w-full h-full [--media-buffering-size:48px]"
      load="eager"
      autoPlay
      src={{
        src: videoUrl,
        type: SUPPORTED_VIDEO_MIME_TYPES[fileFormat] as import("@vidstack/react").VideoMimeType,
      }}
      playsInline
      onLoadedData={clearLoadTimer}
      onError={() => {
        clearLoadTimer();
        setError("Unable to play this video");
      }}
    >
      <MediaProvider />
      {error ? (
        <VideoPlayerError message={error} file={file} onReload={handleReload} />
      ) : (
        <DefaultVideoLayout icons={defaultLayoutIcons} />
      )}
    </MediaPlayer>
  );
};

export default VideoPlayer;
