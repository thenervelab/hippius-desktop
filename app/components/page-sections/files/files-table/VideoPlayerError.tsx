import React from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

import { Icons } from "@/components/ui";
import { AlertCircle, RefreshCw, ExternalLink } from "lucide-react";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

interface VideoPlayerErrorProps {
  message: string;
  file?: FormattedUserFile;
  onReload?: () => void;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string
  ) => void;
}

/**
 * Try to open the file in the system's default video player (VLC, IINA, etc.)
 */
async function openInSystemPlayer(filePath: string) {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(filePath);
  } catch (err) {
    console.error("Failed to open in system player:", err);
  }
}

const VideoPlayerError: React.FC<VideoPlayerErrorProps> = ({
  message,
  file,
  onReload,
  handleFileDownload
}) => {
  const { polkadotAddress } = useWalletAuth();

  // Check if this is a local file that can be opened with the system player
  const localPath = file?.source;
  const isLocalFile =
    localPath &&
    (localPath.includes("/") || localPath.includes("\\"));

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black bg-opacity-70 text-white p-4">
      <div className="mb-6 text-center">
        <AlertCircle className="size-12 mx-auto mb-3 text-red-400" />
        <p className="text-lg font-medium">{message}</p>
        {isLocalFile && (
          <p className="text-sm text-grey-60 mt-2">
            This file is on your computer. Open it with your system player instead.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
        {/* Open in system player — most useful action for local unsupported formats */}
        {isLocalFile && (
          <button
            onClick={() => openInSystemPlayer(localPath)}
            className="flex items-center gap-x-2 bg-primary-50 hover:bg-primary-70 transition-colors px-4 py-2 rounded-md font-medium"
          >
            <ExternalLink className="size-5" />
            <span>Open with System Player</span>
          </button>
        )}

        {onReload && (
          <button
            onClick={onReload}
            className="flex items-center gap-x-2 bg-success-40 hover:bg-success-60 transition-colors px-4 py-2 rounded-md font-medium"
          >
            <RefreshCw className="size-5" />
            <span>Try Loading Again</span>
          </button>
        )}

        {file && (
          <button
            onClick={() => handleFileDownload(file, polkadotAddress ?? "")}
            className="flex items-center gap-x-2 bg-grey-20 hover:bg-grey-30 transition-colors px-4 py-2 rounded-md font-medium"
          >
            <Icons.DocumentDownload className="size-5" />
            <span>Download File</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default VideoPlayerError;
