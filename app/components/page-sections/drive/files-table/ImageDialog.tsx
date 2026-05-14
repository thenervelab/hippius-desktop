import React, { ReactNode, useState, useEffect, useCallback, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { Icons } from "@/components/ui";
import { Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  getNextViewableFile,
  getPrevViewableFile,
  getViewableFilePosition
} from "@/app/lib/utils/mediaNavigation";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";

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
    polkadotAddress: string
  ) => void;
}> = ({ message, file, handleFileDownload }) => {
  const { polkadotAddress } = useWalletAuth();

  return (
    <div className="flex flex-col items-center justify-center text-white p-4 rounded w-full h-full">
      <div className="mb-6 text-center">
        <AlertCircle className="size-12 mx-auto mb-3 text-red-400" />
        <p className="text-lg font-medium">Failed to load image</p>
        <p className="text-sm text-gray-300 mt-2">
          {message ||
            "This image format may not be supported by your browser or the connection failed."}
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
        <button
          onClick={() => handleFileDownload(file, polkadotAddress ?? "")}
          className="flex items-center gap-x-2 bg-primary-50 hover:bg-primary-70 transition-colors px-4 py-2 rounded-md font-medium"
        >
          <Icons.DocumentDownload className="size-5" />
          <span>Download File Instead</span>
        </button>
      </div>
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
    polkadotAddress: string
  ) => void;
}> = ({ file, allFiles, onCloseClicked, onNavigate, handleFileDownload }) => {
  const { polkadotAddress } = useWalletAuth();
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [nextFile, setNextFile] = useState<FormattedUserFile | null>(null);
  const [prevFile, setPrevFile] = useState<FormattedUserFile | null>(null);
  const [resolvedUrl, setResolvedUrl] = useState<string>("");
  const [position, setPosition] = useState<{ current: number; total: number } | null>(null);

  // Track the current file to prevent race conditions
  const currentFileRef = React.useRef<FormattedUserFile | null>(null);

  // All files are private — only navigate between locally synced files
  const navigationOptions = useMemo(() => ({ localOnly: true }), []);

  // Calculate next and previous files whenever the current file changes
  useEffect(() => {
    if (!file) return;

    const next = getNextViewableFile(file, allFiles, navigationOptions);
    const prev = getPrevViewableFile(file, allFiles, navigationOptions);
    const pos = getViewableFilePosition(file, allFiles, navigationOptions);

    setNextFile(next);
    setPrevFile(prev);
    setPosition(pos);
  }, [file, allFiles, navigationOptions]);

  // Resolve URL whenever file changes - with race condition protection
  useEffect(() => {
    if (!file) return;

    // Update ref to track current file
    currentFileRef.current = file;

    // Reset states immediately when file changes
    setImageLoaded(false);
    setImageError(null);

    const result = getFileUrl(file);
    setResolvedUrl(result.url);
  }, [file]);

  const handleNext = useCallback(() => {
    if (nextFile) {
      onNavigate(nextFile);
    }
  }, [nextFile, onNavigate]);

  const handlePrev = useCallback(() => {
    if (prevFile) {
      onNavigate(prevFile);
    }
  }, [prevFile, onNavigate]);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!file) return;

      if (e.key === "ArrowRight" && nextFile) {
        handleNext();
      } else if (e.key === "ArrowLeft" && prevFile) {
        handlePrev();
      } else if (e.key === "Escape") {
        onCloseClicked();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [file, nextFile, prevFile, handleNext, handlePrev, onCloseClicked]);

  // Prevent body and html scroll when dialog is open, and scroll to top
  useEffect(() => {
    if (file) {
      const scrollY = window.scrollY;
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
      window.scrollTo(0, 0);
      return () => {
        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
        window.scrollTo(0, scrollY);
      };
    }
  }, [file]);

  if (!file) return null;

  return (
    <Dialog.Root
      open={!!file}
      onOpenChange={(o) => {
        if (!o) {
          onCloseClicked();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="bg-black/80 fixed inset-0 pt-8 sm:pt-10 md:pt-20 p-3 sm:p-10 md:p-20 z-[999] flex items-center justify-center overflow-hidden data-[state=open]:animate-fade-in-0.3">
          <Dialog.Content className="h-full max-w-screen-1.5xl text-grey-10 w-full flex flex-col items-center">
            {(() => {
              if (file) {

                return (
                  <>
                    <div className="absolute flex justify-center top-4 px-2 sm:px-6 animate-fade-in-0.3 left-0 right-0">
                      <div className="flex justify-between gap-2 sm:gap-6 w-full ">
                        <Dialog.Title className="data-[state=open] font-medium flex items-center gap-x-2 w-full text-xl">
                          <div className="rounded flex items-center justify-center">
                            <Icons.Image className="size-8 " />
                          </div>
                          <span
                            title={file.name}
                            className="truncate max-sm:max-w-[11.25rem] text-grey-100 text-[1.375rem] font-medium"
                          >
                            {file.name}
                          </span>
                          {position && position.total > 1 && (
                            <span className="ml-2 text-sm text-grey-60 font-normal whitespace-nowrap">
                              {position.current} of {position.total}
                            </span>
                          )}
                        </Dialog.Title>

                        <div className="flex gap-x-4 items-center">
                          <button
                            onClick={() => {
                              handleFileDownload(file, polkadotAddress ?? "");
                            }}
                            className="flex duration-300 text-sm font-medium gap-x-2 items-center bg-white whitespace-nowrap rounded border border-grey-80 p-2"
                          >
                            <Icons.DocumentDownload className="size-4 min-w-4" />
                            <span className="max-sm:hidden text-grey-10 text-sm">
                              Download File
                            </span>
                          </button>
                          <button
                            className="duration-300"
                            onClick={onCloseClicked}
                          >
                            <Icons.CloseCircle className="size-7 [&>path]:stroke-2 text-grey-100" />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Left navigation button */}
                    {prevFile && (
                      <button
                        onClick={handlePrev}
                        className="absolute left-5 top-1/2 -translate-y-1/2 z-10 border border-grey-80 bg-white/80 hover:bg-white rounded-full p-3 shadow-lg transition-all duration-300 hover:scale-110"
                        aria-label="Previous image"
                      >
                        <Icons.ArrowLeft2 className="size-6 text-grey-50" />
                      </button>
                    )}

                    {/* Right navigation button */}
                    {nextFile && (
                      <button
                        onClick={handleNext}
                        className="absolute right-5 top-1/2 -translate-y-1/2 z-10 border border-grey-80 bg-white/80 hover:bg-white rounded-full p-3 shadow-lg transition-all duration-300 hover:scale-110"
                        aria-label="Next image"
                      >
                        <Icons.ArrowRight2 className="size-6 text-grey-50" />
                      </button>
                    )}

                    <div
                      onClick={onCloseClicked}
                      className="w-full h-full flex items-center justify-center"
                    >
                      {/* Loading spinner - show when loading image */}
                      {(!imageLoaded && !imageError && resolvedUrl) && (
                        <div className="absolute top-0 left-0 h-full flex items-center justify-center w-full pointer-events-none">
                          <Loader2 className="size-6 text-primary-50 animate-spin" />
                        </div>
                      )}

                      {!imageError && resolvedUrl && (
                        <motion.div
                          key={file.actualFileName || file.name} // Force re-mount on file change
                          layout
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{
                            opacity: imageLoaded ? 1 : 0,
                            scale: imageLoaded ? 1 : 1.0
                          }}
                          transition={{ duration: 0.3, ease: "easeInOut" }}
                          onClick={(e) => e.stopPropagation()}
                          className="min-w-28 min-h-28 relative shadow-dialog flex max-w-full max-h-full h-fit flex-col rounded overflow-hidden"
                        >
                          <img
                            key={resolvedUrl} // Force new image element when URL changes
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
                              "max-h-[80vh] duration-300 opacity-0 max-w-full relative w-auto h-auto object-contain rounded",
                              imageLoaded && "opacity-100"
                            )}
                          />
                        </motion.div>
                      )}

                      {/* Error Container */}
                      {imageError && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.3, ease: "easeInOut" }}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full max-w-md mx-auto shadow-dialog bg-black/70 backdrop-blur-sm rounded-lg overflow-hidden"
                        >
                          <ImageError
                            handleFileDownload={handleFileDownload}
                            message={imageError}
                            file={file}
                          />
                        </motion.div>
                      )}
                    </div>
                  </>
                );
              }
            })()}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default ImageDialog;
