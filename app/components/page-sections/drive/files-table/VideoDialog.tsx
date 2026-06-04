import React, { ReactNode } from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { Video, AlertCircle } from "lucide-react";
import VideoPlayer from "./VideoPlayer";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { cn } from "@/lib/utils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useViewableFileUrl } from "@/app/lib/hooks/useViewableFileUrl";
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
      <div className="absolute pointer-events-none opacity-0 transition-opacity duration-300 group-hover:opacity-100 right-4 inset-y-0 flex items-center">
        <Video className="size-4 text-primary-60" />
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
  onDelete?: (file: FormattedUserFile) => void;
}> = ({
  file,
  allFiles,
  onCloseClicked,
  onNavigate,
  handleFileDownload,
  onDelete,
}) => {
  const { polkadotAddress } = useWalletAuth();
  // Local URL for synced files; on-demand cloud decrypt for files that aren't
  // on disk (sidebar-search results that live only on the server).
  const { url: resolvedUrl, error: resolveError } = useViewableFileUrl(file);

  if (!file) return null;

  const { fileFormat } = getFilePartsFromFileName(file.name);

  return (
    <FileViewerLayout
      file={file}
      allFiles={allFiles}
      onClose={onCloseClicked}
      onNavigate={onNavigate}
      handleFileDownload={handleFileDownload}
      onDelete={onDelete}
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
        ) : resolveError ? (
          <div className="flex flex-col items-center justify-center gap-3 w-full h-full p-6 text-center text-grey-10 dark:text-grey-light-100">
            <AlertCircle className="size-10 text-red-400" />
            <p className="text-sm font-medium max-w-sm">{resolveError}</p>
            <button
              onClick={() => handleFileDownload(file, polkadotAddress ?? "")}
              className="flex items-center gap-x-2 bg-primary-50 hover:bg-primary-70 transition-colors px-4 py-2 rounded-md font-medium text-white"
            >
              <span>Download File Instead</span>
            </button>
          </div>
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
