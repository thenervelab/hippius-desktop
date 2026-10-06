import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Film } from "lucide-react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import VideoPlayer from "@/app/components/page-sections/drive/files-table/VideoPlayer";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { cn } from "@/lib/utils";
import { useViewableFileUrl } from "@/app/lib/hooks/useViewableFileUrl";

import PreviewSurface from "./PreviewSurface";
import { PreviewFallback, PreviewLoading } from "./PreviewState";

// Linux: hand the file to the system's default video player (`xdg-open`
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
 * Whether this platform plays videos in the viewer, from Rust's
 * `get_platform_info` (`supportsInAppVideo`); `null` until it answers. A
 * failed answer keeps the built-in player, as before.
 */
function useInAppVideo(): boolean | null {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<{ supportsInAppVideo?: boolean }>("get_platform_info")
      .then((info) => {
        if (!cancelled) setSupported(info?.supportsInAppVideo !== false);
      })
      .catch(() => {
        if (!cancelled) setSupported(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return supported;
}

/**
 * Video renderer body for the unified viewer.
 *
 * The player streams from the resolved URL rather than buffered bytes, so a
 * large file starts immediately and is never held in memory — which is why
 * video (like image and PDF) stays on the URL path instead of going through
 * `read_preview_bytes`.
 *
 * On Linux (Rust's `supportsInAppVideo` is false) there is no player: the
 * WebKitGTK webview showed a screen recording as a black frame with a
 * spinner. The viewer says so and offers Download and the system's video
 * player, which opens the local copy (a cloud-only file is fetched into the
 * preview cache first, as for PDFs).
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
  const inAppVideo = useInAppVideo();

  if (inAppVideo === false) {
    return (
      <PreviewSurface className="items-center justify-center">
        <PreviewFallback
          icon={<Film className="mx-auto mb-3 size-12 text-primary-50" aria-hidden />}
          title="Play this video in your video player"
          description={
            resolveError ??
            (isLoading
              ? "Getting the video ready to open…"
              : "Videos don't play inside Hippius on Linux. Open it in your video player, or download it.")
          }
          file={file}
          handleFileDownload={handleFileDownload}
          openExternallyLabel="Open in your video player"
          openExternallyPending={isLoading}
          onOpenExternally={localPath && !resolveError ? () => void openInVideoPlayer(localPath) : undefined}
        />
      </PreviewSurface>
    );
  }

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

  return (
    <PreviewSurface className="items-center justify-center">
      <div
        className={cn(
          "relative w-full h-full min-h-0 min-w-0 flex flex-col rounded-[8px] overflow-hidden",
          "bg-grey-light-300 dark:bg-black-primary-bg",
          "shadow-[0_14px_31px_rgba(0,0,0,0.06),0_56px_56px_rgba(0,0,0,0.05)]",
          "animate-scale-in-95-0.4",
        )}
      >
        {resolvedUrl && inAppVideo ? (
          <VideoPlayer
            key={resolvedUrl}
            videoUrl={resolvedUrl}
            isFromIpfs={false}
            isFromLocal={true}
            fileFormat={fileFormat}
            file={file}
            handleFileDownload={handleFileDownload}
          />
        ) : (
          <PreviewLoading title="Loading video…" />
        )}
      </div>
    </PreviewSurface>
  );
};

export default VideoPreviewBody;
