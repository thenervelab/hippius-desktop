import React from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import VideoPlayer from "@/app/components/page-sections/drive/files-table/VideoPlayer";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { cn } from "@/lib/utils";
import { useViewableFileUrl } from "@/app/lib/hooks/useViewableFileUrl";

import PreviewSurface from "./PreviewSurface";
import { PreviewFallback, PreviewLoading } from "./PreviewState";

/**
 * Video renderer body for the unified viewer.
 *
 * The player streams from the resolved URL rather than buffered bytes, so a
 * large file starts immediately and is never held in memory — which is why
 * video (like image and PDF) stays on the URL path instead of going through
 * `read_preview_bytes`.
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
  const { url: resolvedUrl, error: resolveError } = useViewableFileUrl(file);
  const { fileFormat } = getFilePartsFromFileName(file.name);

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
        {resolvedUrl ? (
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
