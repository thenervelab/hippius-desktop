import React, { ReactNode, useState, useEffect } from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { Icons } from "@/components/ui";
import { Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";
import { FileViewerLayout } from "@/app/components/page-sections/drive/file-viewer";

export const ImageDialogTrigger: React.FC<{
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
      {/* Eye icon on hover */}
      <div className="absolute pointer-events-none pl-16 bg-gradient-to-r from-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100 to-white dark:to-black-300 right-4 inset-y-0 flex items-center">
        <Icons.Eye className="size-5 text-primary-60 [&>path]:stroke-[0.1875rem]" />
      </div>
    </button>
  );
};

const ImageError: React.FC<{
  message: string;
  file: FormattedUserFile;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string,
  ) => void;
}> = ({ message, file, handleFileDownload }) => {
  const { polkadotAddress } = useWalletAuth();

  return (
    <div className="flex flex-col items-center justify-center text-grey-10 dark:text-grey-light-100 p-6 rounded-[12px] w-full max-w-md bg-white/80 dark:bg-black-primary-bg/80 border border-grey-dark-100 dark:border-black-300 backdrop-blur-sm">
      <div className="mb-6 text-center">
        <AlertCircle className="size-12 mx-auto mb-3 text-red-400" />
        <p className="text-lg font-medium">Failed to load image</p>
        <p className="text-sm text-grey-50 dark:text-grey-light-300 mt-2">
          {message ||
            "This image format may not be supported by your browser or the connection failed."}
        </p>
      </div>

      <button
        onClick={() => handleFileDownload(file, polkadotAddress ?? "")}
        className="flex items-center gap-x-2 bg-primary-50 hover:bg-primary-70 transition-colors px-4 py-2 rounded-md font-medium text-white"
      >
        <Icons.DocumentDownload className="size-5" />
        <span>Download File Instead</span>
      </button>
    </div>
  );
};

const ImageDialog: React.FC<{
  file: null | FormattedUserFile;
  allFiles: FormattedUserFile[];
  onCloseClicked: () => void;
  onNavigate: (file: FormattedUserFile) => void;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string,
  ) => void;
}> = ({ file, allFiles, onCloseClicked, onNavigate, handleFileDownload }) => {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [resolvedUrl, setResolvedUrl] = useState<string>("");

  // Reset state and resolve a fresh URL whenever the open file changes,
  // before mount as well as when navigating between files in the strip.
  useEffect(() => {
    if (!file) return;
    setImageLoaded(false);
    setImageError(null);
    setResolvedUrl(getFileUrl(file).url);
  }, [file]);

  if (!file) return null;

  return (
    <FileViewerLayout
      file={file}
      allFiles={allFiles}
      onClose={onCloseClicked}
      onNavigate={onNavigate}
      handleFileDownload={handleFileDownload}
    >
      <div className="relative w-full h-full min-h-0 min-w-0 flex items-center justify-center">
        {!imageLoaded && !imageError && resolvedUrl && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Loader2 className="size-6 text-primary-50 animate-spin" />
          </div>
        )}

        {!imageError && resolvedUrl && (
          <motion.div
            key={file.actualFileName || file.name}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{
              opacity: imageLoaded ? 1 : 0,
              scale: imageLoaded ? 1 : 1.0,
            }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="relative w-full h-full min-h-0 min-w-0 flex items-center justify-center"
          >
            <img
              key={resolvedUrl}
              onLoad={() => {
                setImageLoaded(true);
                setImageError(null);
              }}
              onError={() => {
                setImageLoaded(false);
                setImageError("Failed to load image");
              }}
              src={resolvedUrl}
              alt={file.name}
              className={cn(
                "max-h-full max-w-full w-auto h-auto object-contain rounded-[8px]",
                "shadow-[0_14px_31px_rgba(0,0,0,0.06),0_56px_56px_rgba(0,0,0,0.05)]",
                "duration-300 opacity-0",
                imageLoaded && "opacity-100",
              )}
            />
          </motion.div>
        )}

        {imageError && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
          >
            <ImageError
              handleFileDownload={handleFileDownload}
              message={imageError}
              file={file}
            />
          </motion.div>
        )}
      </div>
    </FileViewerLayout>
  );
};

export default ImageDialog;
