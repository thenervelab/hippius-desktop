import React from "react";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";

import { Icons } from "@/components/ui";
import { downloadIpfsFile } from "@/lib/utils/downloadIpfsFile";
import { AlertCircle, RefreshCw } from "lucide-react";

interface VideoPlayerErrorProps {
  message: string;
  file?: FormattedUserIpfsFile;
  onReload?: () => void;
}

const VideoPlayerError: React.FC<VideoPlayerErrorProps> = ({
  message,
  file,
  onReload,
}) => {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black bg-opacity-70 text-white p-4">
      <div className="mb-6 text-center">
        <AlertCircle className="size-12 mx-auto mb-3 text-red-400" />
        <p className="text-lg font-medium">{message}</p>
        <p className="text-sm text-gray-300 mt-2">
          {message.includes("Firefox")
            ? "Please use Chrome instead."
            : "This format may not be supported by your browser or the connection is slow."}
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
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
            onClick={() => downloadIpfsFile(file)}
            className="flex items-center gap-x-2 bg-primary-50 hover:bg-primary-70 transition-colors px-4 py-2 rounded-md font-medium"
          >
            <Icons.DocumentDownload className="size-5" />
            <span>Download File Instead</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default VideoPlayerError;
