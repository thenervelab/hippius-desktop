import React, { useEffect, useRef, useState } from "react";
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
interface VideoPlayerProps {
  videoUrl: string;
  fileFormat: string;
  file?: FormattedUserFile;
  isFromIpfs?: boolean;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string
  ) => void;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({
  videoUrl,
  fileFormat,
  isFromIpfs = false,
  file,
  handleFileDownload
}) => {
  const [error, setError] = useState<string>("");
  const [playUrl, setPlayUrl] = useState<string>("");

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

      if (isFromIpfs) {
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
  }, [videoUrl, isFromIpfs]);
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
    <MediaPlayer
      key={reloadKey}
      className="relative w-full h-full [--media-buffering-size:48px]"
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
  );
};

export default VideoPlayer;
