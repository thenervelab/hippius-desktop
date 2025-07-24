// ImageErrorOverlay.tsx
import React from "react";
import { AlertCircle } from "lucide-react";
import { Icons } from "@/components/ui";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";

interface Props {
  message: string;
  file?: FormattedUserIpfsFile;
  onDownload?: () => void;
}

const ImageErrorOverlay: React.FC<Props> = ({ message, file, onDownload }) => {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 text-white p-4 z-10">
      <AlertCircle className="size-12 mb-3 text-red-400" />
      <p className="text-lg font-medium">{message}</p>
      <p className="text-sm text-gray-300 mt-2">
        The image couldn’t be loaded. You can download it instead.
      </p>

      {file && onDownload && (
        <button
          onClick={onDownload}
          className="mt-6 flex items-center gap-x-2 bg-primary-50 hover:bg-primary-70 transition-colors px-4 py-2 rounded-md font-medium"
        >
          <Icons.DocumentDownload className="size-5" />
          <span>Download File</span>
        </button>
      )}
    </div>
  );
};

export default ImageErrorOverlay;
