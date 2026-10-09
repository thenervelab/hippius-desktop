import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Film } from "lucide-react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import VideoPlayer from "@/app/components/page-sections/drive/files-table/VideoPlayer";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { cn } from "@/lib/utils";
import { useViewableFileUrl } from "@/app/lib/hooks/useViewableFileUrl";

import PreviewSurface from "./PreviewSurface";
import { PreviewFallback, PreviewLoading } from "./PreviewState";

/**
 * How Rust says to play a video (`video_playback_source`, `video_stream.rs`).
 * `webview`: the asset URL (macOS, Windows). `stream`: a loopback URL
 * (Linux, where WebKitGTK cannot play media from `asset://`), with how long
 * the player may take to show a frame and the line to show if it does not.
 * `decoderMissing` / `unavailable`: no player, Rust's line instead.
 */
export type VideoPlayback =
  | { kind: "webview" }
  | { kind: "stream"; url: string; startWithinMs: number; startFailedMessage: string }
  | { kind: "decoderMissing"; message: string }
  | { kind: "unavailable"; message: string };

// Shown only when the IPC itself failed (the file is outside the viewer's
// gate, or nobody is signed in), so Rust had no line to give.
const CANNOT_PLAY = "This video can't be played here. Open it in your video player, or download it.";

// Under the player when a stream keeps pausing to wait for data.
const STUTTER_LINE = "Not playing smoothly? Your video player may play it better.";

// Hand the file to the system's default video player (`xdg-open` on Linux,
// through the opener plugin), as the Linux PDF path does.
async function openInVideoPlayer(filePath: string) {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(filePath);
  } catch (err) {
    console.error("Failed to open the video in the system player:", err);
  }
}

/**
 * Ask Rust how to play the file at `localPath`; `null` until it answers. A
 * stream's token is released when the viewer moves on or closes.
 */
function useVideoPlayback(localPath: string): { playback: VideoPlayback | null; failed: boolean } {
  const [state, setState] = useState<{ playback: VideoPlayback | null; failed: boolean }>({
    playback: null,
    failed: false,
  });
  useEffect(() => {
    setState({ playback: null, failed: false });
    if (!localPath) return;
    let cancelled = false;
    let streamUrl: string | null = null;
    invoke<VideoPlayback>("video_playback_source", { sourcePath: localPath })
      .then((playback) => {
        if (playback?.kind === "stream") streamUrl = playback.url;
        if (cancelled) {
          if (streamUrl) void invoke("video_stream_release", { url: streamUrl }).catch(() => {});
          return;
        }
        setState({ playback, failed: false });
      })
      .catch((err: unknown) => {
        console.error("Failed to prepare the video for playback:", err);
        if (!cancelled) setState({ playback: null, failed: true });
      });
    return () => {
      cancelled = true;
      if (streamUrl) void invoke("video_stream_release", { url: streamUrl }).catch(() => {});
    };
  }, [localPath]);
  return state;
}

/**
 * Video renderer body for the unified viewer.
 *
 * The player streams from a URL rather than buffered bytes, so a large file
 * starts immediately and is never held in memory, which is why video (like
 * image and PDF) stays on the URL path instead of going through
 * `read_preview_bytes`.
 *
 * Rust decides how it plays (`video_playback_source`). On Linux the URL is
 * the app's loopback stream, and the player gets `startWithinMs` to show its
 * first frame: if it errors or no frame comes in time, the viewer offers the
 * system's video player and Download with Rust's line, never a spinner that
 * runs forever. Without an H.264 decoder there is no player at all, only
 * that offer and the package to install.
 */
const VideoPreviewBody: React.FC<{
  file: FormattedUserFile;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string,
  ) => void;
}> = ({ file, handleFileDownload }) => {
  // Local URL for synced files; on-demand cloud decrypt for files that aren't
  // on disk (sidebar-search results that live only on the server).
  const { url: resolvedUrl, localPath, isLoading, error: resolveError } = useViewableFileUrl(file);
  const { fileFormat } = getFilePartsFromFileName(file.name);
  const { playback, failed: playbackFailed } = useVideoPlayback(resolveError ? "" : localPath);

  // The start watchdog, for a stream only.
  const [startFailed, setStartFailed] = useState(false);
  const [started, setStarted] = useState(false);
  const streamUrl = playback?.kind === "stream" ? playback.url : null;
  const startWithinMs = playback?.kind === "stream" ? playback.startWithinMs : 0;
  useEffect(() => {
    setStartFailed(false);
    setStarted(false);
  }, [streamUrl]);
  useEffect(() => {
    if (!streamUrl || started || startFailed) return;
    const timer = window.setTimeout(() => setStartFailed(true), startWithinMs);
    return () => window.clearTimeout(timer);
  }, [streamUrl, startWithinMs, started, startFailed]);
  const onPlaybackStarted = useCallback(() => setStarted(true), []);
  const onPlaybackFailed = useCallback(() => setStartFailed(true), []);
  // A stream that keeps stopping to wait (WebKitGTK's GStreamer player) gets
  // the system's player offered beside it, not instead of it.
  const [stutteredUrl, setStutteredUrl] = useState<string | null>(null);
  const onPlaybackStuttered = useCallback(() => setStutteredUrl(streamUrl), [streamUrl]);
  const stuttered = streamUrl !== null && stutteredUrl === streamUrl;

  if (resolveError) {
    return (
      <PreviewSurface className="items-center justify-center">
        <PreviewFallback
          title="Failed to load video"
          description={resolveError}
          file={file}
          handleFileDownload={handleFileDownload}
        />
      </PreviewSurface>
    );
  }

  const fallbackLine =
    playback?.kind === "decoderMissing" || playback?.kind === "unavailable"
      ? playback.message
      : playback?.kind === "stream" && startFailed
        ? playback.startFailedMessage
        : playbackFailed
          ? CANNOT_PLAY
          : null;

  if (fallbackLine) {
    return (
      <PreviewSurface className="items-center justify-center">
        <PreviewFallback
          icon={<Film className="mx-auto mb-3 size-12 text-primary-50" aria-hidden />}
          title="Play this video in your video player"
          description={fallbackLine}
          file={file}
          handleFileDownload={handleFileDownload}
          openExternallyLabel="Open in your video player"
          onOpenExternally={localPath ? () => void openInVideoPlayer(localPath) : undefined}
        />
      </PreviewSurface>
    );
  }

  const playUrl =
    playback?.kind === "stream" ? playback.url : playback?.kind === "webview" ? resolvedUrl : "";

  return (
    <PreviewSurface className="items-center justify-center">
      <div
        className={cn(
          "relative w-full flex-1 min-h-0 min-w-0 flex flex-col rounded-[8px] overflow-hidden",
          "bg-grey-light-300 dark:bg-black-primary-bg",
          "shadow-[0_14px_31px_rgba(0,0,0,0.06),0_56px_56px_rgba(0,0,0,0.05)]",
          "animate-scale-in-95-0.4",
        )}
      >
        {playUrl && !isLoading ? (
          <VideoPlayer
            key={playUrl}
            videoUrl={playUrl}
            isFromIpfs={false}
            isFromLocal={true}
            fileFormat={fileFormat}
            file={file}
            handleFileDownload={handleFileDownload}
            onPlaybackStarted={streamUrl ? onPlaybackStarted : undefined}
            onPlaybackFailed={streamUrl ? onPlaybackFailed : undefined}
            onPlaybackStuttered={streamUrl ? onPlaybackStuttered : undefined}
          />
        ) : (
          <PreviewLoading title="Loading video…" />
        )}
      </div>
      {stuttered && localPath ? (
        <div
          role="status"
          className="mt-3 flex w-full shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-2 px-4 text-center text-sm text-grey-50 dark:text-grey-light-300"
        >
          <span>{STUTTER_LINE}</span>
          <button
            type="button"
            onClick={() => void openInVideoPlayer(localPath)}
            className="rounded-[8px] border border-primary-50 px-3 py-1.5 text-sm font-medium text-primary-50 hover:bg-primary-50 hover:text-white"
          >
            Open in your video player
          </button>
        </div>
      ) : null}
    </PreviewSurface>
  );
};

export default VideoPreviewBody;
