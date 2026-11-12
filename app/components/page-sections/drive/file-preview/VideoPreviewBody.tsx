import React, { useCallback, useEffect, useState } from "react";
import { Film } from "lucide-react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import VideoPlayer from "@/app/components/page-sections/drive/files-table/VideoPlayer";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { cn } from "@/lib/utils";
import { useViewableFileUrl } from "@/app/lib/hooks/useViewableFileUrl";
import { convertFileSrc } from "@tauri-apps/api/core";

import PreviewSurface from "./PreviewSurface";
import { openInDefaultApp } from "./previewBytes";
import { PreviewFallback, PreviewLoading } from "./PreviewState";
import { useVideoPlayback, useVideoPreview } from "./videoPlayback";

export type { VideoPlayback, VideoPreview } from "./videoPlayback";

// Shown only when the IPC itself failed (the file is outside the viewer's
// gate, or nobody is signed in), so Rust had no line to give.
const CANNOT_PLAY = "This video can't be played here. Open it in your video player, or download it.";

// Rust's line for a video nothing here can play (`CANNOT_PREVIEW`), for when
// the IPC itself failed after the webview had already given up.
const CANNOT_PREVIEW = "This video can't be previewed. Download it to play it.";

// Under the player when a stream keeps pausing to wait for data.
const STUTTER_LINE = "Not playing smoothly? Your video player may play it better.";

// Hand the file to the system's default video player (`xdg-open` on Linux,
// through the opener plugin), as the Linux PDF path does.
async function openInVideoPlayer(filePath: string) {
  try {
    await openInDefaultApp(filePath);
  } catch (err) {
    console.error("Failed to open the video in the system player:", err);
  }
}

/**
 * Video renderer body for the unified viewer.
 *
 * The player streams from a URL rather than buffered bytes, so a large file
 * starts immediately and is never held in memory, which is why video (like
 * image and PDF) stays on the URL path instead of going through
 * `read_preview_bytes`.
 *
 * Rust first says whether the webview can play the file at all
 * (`video_preview_open`, `src-tauri/src/video_engine/`): `native` keeps the
 * path below; a WMV, AVI, MKV and the like come back as a converted copy
 * (`file`) or an HLS stream converted as it plays (`stream`), with
 * "Preparing preview…" meanwhile; `unsupported` shows Rust's line and
 * Download. When the webview's own player fails on a file Rust called
 * native (HEVC on Windows), Rust is asked again to convert it.
 *
 * How a local file plays is Rust's call too (`video_playback_source`). On
 * Linux the URL is the app's loopback stream, and the player gets
 * `startWithinMs` to show its first frame: if it errors or no frame comes in
 * time, the viewer tries the conversion, then offers the system's video
 * player and Download with Rust's line, never a spinner that runs forever.
 * Without an H.264 decoder there is no player at all, only that offer and
 * the package to install.
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

  // Set once the webview's own player failed on the file: `line` is what to
  // say if the conversion cannot help either (Linux's start-failed line), or
  // null for Rust's own.
  const [nativeFailure, setNativeFailure] = useState<{ path: string; line: string | null } | null>(null);
  const webviewFailed = nativeFailure !== null && nativeFailure.path === localPath;
  const preview = useVideoPreview(resolveError ? "" : localPath, webviewFailed);
  const ready = preview.status === "ready" ? preview.preview : null;
  // An open that failed before the webview tried (an IPC error) leaves the
  // existing path in charge, as it was before conversion existed.
  const native = !webviewFailed && (ready?.kind === "native" || preview.status === "failed");
  const converted = ready?.kind === "file" || ready?.kind === "stream" ? ready : null;
  const playbackPath = native ? localPath : converted?.kind === "file" ? converted.path : "";
  const { playback, failed: playbackFailed } = useVideoPlayback(playbackPath);

  // A converted preview that the player still could not play.
  const [convertedFailedFor, setConvertedFailedFor] = useState<string | null>(null);
  const convertedKey = converted ? (converted.kind === "file" ? converted.path : converted.url) : null;
  const convertedFailed = convertedKey !== null && convertedFailedFor === convertedKey;

  // The start watchdog, for a stream only.
  const [startFailed, setStartFailed] = useState(false);
  const [started, setStarted] = useState(false);
  const streamUrl = playback?.kind === "stream" ? playback.url : null;
  const startWithinMs = playback?.kind === "stream" ? playback.startWithinMs : 0;
  const hlsUrl = converted?.kind === "stream" ? converted.url : null;
  useEffect(() => {
    setStartFailed(false);
    setStarted(false);
  }, [streamUrl, hlsUrl]);
  useEffect(() => {
    if (!streamUrl || started || startFailed) return;
    const timer = window.setTimeout(() => setStartFailed(true), startWithinMs);
    return () => window.clearTimeout(timer);
  }, [streamUrl, startWithinMs, started, startFailed]);

  // What a failed start or a player error means depends on what was playing:
  // the file itself gets one try at conversion; a converted copy falls back.
  const playbackLine = playback?.kind === "stream" ? playback.startFailedMessage : null;
  const failNow = useCallback(() => {
    if (native) {
      setNativeFailure({ path: localPath, line: playbackLine });
    } else if (convertedKey) {
      setConvertedFailedFor(convertedKey);
    }
  }, [native, localPath, playbackLine, convertedKey]);
  useEffect(() => {
    if (startFailed) failNow();
  }, [startFailed, failNow]);

  const onPlaybackStarted = useCallback(() => setStarted(true), []);
  const onPlaybackFailed = useCallback(() => {
    setStartFailed(false);
    failNow();
  }, [failNow]);
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

  const rustLine = ready?.kind === "unsupported" ? ready.message : null;
  const fallbackLine =
    playback?.kind === "decoderMissing" || playback?.kind === "unavailable"
      ? playback.message
      : webviewFailed && (rustLine || preview.status === "failed")
        ? (nativeFailure?.line ?? rustLine ?? CANNOT_PREVIEW)
        : rustLine
          ? rustLine
          : convertedFailed
            ? (nativeFailure?.line ?? CANNOT_PREVIEW)
            : playbackFailed
              ? CANNOT_PLAY
              : null;

  if (fallbackLine) {
    return (
      <PreviewSurface className="items-center justify-center">
        <PreviewFallback
          icon={<Film className="mx-auto mb-3 size-12 text-primary-50" aria-hidden />}
          title={
            fallbackLine === rustLine || fallbackLine === CANNOT_PREVIEW
              ? "Can't preview this video"
              : "Play this video in your video player"
          }
          description={fallbackLine}
          file={file}
          handleFileDownload={handleFileDownload}
          openExternallyLabel="Open in your video player"
          onOpenExternally={localPath ? () => void openInVideoPlayer(localPath) : undefined}
        />
      </PreviewSurface>
    );
  }

  const fileUrl =
    playback?.kind === "stream"
      ? playback.url
      : playback?.kind === "webview"
        ? native
          ? resolvedUrl
          : converted?.kind === "file"
            ? convertFileSrc(converted.path)
            : ""
        : "";
  const playUrl = hlsUrl ?? fileUrl;
  const preparingTitle =
    preview.status === "preparing" && preview.percent !== null
      ? `Preparing preview… ${preview.percent}%`
      : webviewFailed
        ? "Preparing preview…"
        : "Loading video…";

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
          <>
            <VideoPlayer
              key={playUrl}
              videoUrl={playUrl}
              isFromIpfs={false}
              isFromLocal={true}
              fileFormat={hlsUrl ? "m3u8" : converted?.kind === "file" ? "mp4" : fileFormat}
              file={file}
              handleFileDownload={handleFileDownload}
              hls={hlsUrl !== null}
              onPlaybackStarted={streamUrl || hlsUrl ? onPlaybackStarted : undefined}
              onPlaybackFailed={onPlaybackFailed}
              onPlaybackStuttered={streamUrl ? onPlaybackStuttered : undefined}
            />
            {hlsUrl && !started ? (
              // The first segment is being converted; the player's own
              // spinner would say nothing about why it takes a moment.
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-grey-light-300 dark:bg-black-primary-bg">
                <PreviewLoading title="Preparing preview…" />
              </div>
            ) : null}
          </>
        ) : (
          <PreviewLoading title={preparingTitle} />
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
