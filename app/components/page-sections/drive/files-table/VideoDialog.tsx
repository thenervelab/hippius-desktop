import React, { ReactNode, useState, useEffect } from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { Icons } from "@/components/ui";
import VideoPlayer from "./VideoPlayer";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { cn } from "@/lib/utils";
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";
import { FileViewerLayout } from "@/app/components/page-sections/drive/file-viewer";

export const VideoDialogTrigger: React.FC<{
  children: ReactNode;
  onClick: () => void;
  className?: string;
}> = ({ children, onClick, className }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative group overflow-hidden flex items-center w-full px-2 py-[5px]",
        className,
      )}
    >
      <span className="flex-1 min-w-0">{children}</span>
      {/* Play icon on hover */}
      <div className="absolute pointer-events-none pl-16 bg-gradient-to-r from-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100 to-white dark:to-black-300 right-4 inset-y-0 flex items-center">
        <Icons.PlayCircle className="size-5 text-primary-60 [&>path]:stroke-[0.25rem]" />
      </div>
    </button>
  );
};

const VideoDialog: React.FC<{
  file: null | FormattedUserFile;
  allFiles: FormattedUserFile[];
  onCloseClicked: () => void;
  onNavigate: (file: FormattedUserFile) => void;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string,
  ) => void;
}> = ({ file, allFiles, onCloseClicked, onNavigate, handleFileDownload }) => {
  const [resolvedUrl, setResolvedUrl] = useState<string>("");

  useEffect(() => {
    if (!file) return;
    setResolvedUrl("");
    setResolvedUrl(getFileUrl(file).url);
  }, [file]);

  if (!file) return null;

  const { fileFormat } = getFilePartsFromFileName(file.name);

  return (
    <FileViewerLayout
      file={file}
      allFiles={allFiles}
      onClose={onCloseClicked}
      onNavigate={onNavigate}
      handleFileDownload={handleFileDownload}
    >
      <div
        className={cn(
          "relative w-full h-full min-h-0 min-w-0 flex flex-col rounded-[8px] overflow-hidden",
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
          <div className="flex items-center justify-center w-full h-full">
            <div className="animate-spin rounded-full size-8 border-b-2 border-primary-50" />
          </div>
        )}
      </div>
    </FileViewerLayout>
  );
};

export default VideoDialog;
