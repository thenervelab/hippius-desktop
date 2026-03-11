import React, { ReactNode, useState, useEffect, useCallback, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { Icons } from "@/components/ui";
import VideoPlayer from "./VideoPlayer";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import {
  getNextViewableFile,
  getPrevViewableFile,
  getViewableFilePosition
} from "@/app/lib/utils/mediaNavigation";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";

export const VideoDialogTrigger: React.FC<{
  children: ReactNode;
  onClick: () => void;
}> = ({ children, onClick }) => {
  return (
    <button
      onClick={onClick}
      className="px-4 py-[22px] relative group overflow-hidden flex items-center w-full"
    >
      <span className="flex-1 min-w-0">{children}</span>
      {/* Play icon on hover */}
      <div className="absolute pointer-events-none pl-16 bg-gradient-to-r from-transparent translate-x-6 opacity-0 duration-300 group-hover:translate-x-0 group-hover:opacity-100 to-white right-4">
        <Icons.PlayCircle className="size-5 text-primary-60 [&>path]:stroke-[4px]" />
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
    polkadotAddress: string
  ) => void;
  isPrivateView?: boolean;
}> = ({ file, allFiles, onCloseClicked, onNavigate, handleFileDownload, isPrivateView = false }) => {
  const [nextFile, setNextFile] = useState<FormattedUserFile | null>(null);
  const [prevFile, setPrevFile] = useState<FormattedUserFile | null>(null);
  const [resolvedUrl, setResolvedUrl] = useState<string>("");
  const [position, setPosition] = useState<{ current: number; total: number } | null>(null);
  const { polkadotAddress } = useWalletAuth();

  // Track the current file to prevent race conditions
  const currentFileRef = React.useRef<FormattedUserFile | null>(null);

  // For private files, only navigate between locally synced files
  const navigationOptions = useMemo(() => ({ localOnly: isPrivateView }), [isPrivateView]);

  useEffect(() => {
    if (!file) return;

    const next = getNextViewableFile(file, allFiles, navigationOptions);
    const prev = getPrevViewableFile(file, allFiles, navigationOptions);
    const pos = getViewableFilePosition(file, allFiles, navigationOptions);

    setNextFile(next);
    setPrevFile(prev);
    setPosition(pos);
  }, [file, allFiles, navigationOptions]);

  // Resolve URL whenever file changes
  useEffect(() => {
    if (!file) return;

    currentFileRef.current = file;
    setResolvedUrl("");

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

  const { fileFormat } = getFilePartsFromFileName(file.name);
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
          <Dialog.Content className="h-full max-w-screen-1.5xl max-h-[90vh] text-grey-10 w-full flex flex-col">
            {(() => {
              if (file) {
                return (
                  <>
                    <div className="absolute flex justify-center top-4 px-2 sm:px-6 animate-fade-in-0.3 left-0 right-0">
                      <div className="flex justify-between gap-2 sm:gap-6 w-full ">
                        <Dialog.Title className="data-[state=open] font-medium flex items-center gap-x-2 min-w-0 flex-1 text-xl">
                          <div className="rounded flex-shrink-0 flex items-center justify-center">
                            <Icons.Video className="size-8" />
                          </div>
                          <span
                            title={file.name}
                            className="truncate text-grey-100 text-[22px] font-medium"
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

                    {prevFile && (
                      <button
                        onClick={handlePrev}
                        className="absolute left-5 top-1/2 -translate-y-1/2 z-10 border border-grey-80 bg-white/80 hover:bg-white rounded-full p-3 shadow-lg transition-all duration-300 hover:scale-110"
                        aria-label="Previous video"
                      >
                        <Icons.ArrowLeft2 className="size-6 text-grey-50" />
                      </button>
                    )}

                    {nextFile && (
                      <button
                        onClick={handleNext}
                        className="absolute right-5 top-1/2 -translate-y-1/2 z-10 border border-grey-80 bg-white/80 hover:bg-white rounded-full p-3 shadow-lg transition-all duration-300 hover:scale-110"
                        aria-label="Next video"
                      >
                        <Icons.ArrowRight2 className="size-6 text-grey-50" />
                      </button>
                    )}

                    <div className="animate-scale-in-95-0.4 shadow-dialo grow flex w-full h-full flex-col mt-12 rounded overflow-hidden relative data-[state=open]:animate-scale-in-95-0.4">
                      {resolvedUrl ? (
                        <VideoPlayer
                          key={resolvedUrl} // Force re-mount on URL change
                          videoUrl={resolvedUrl}
                          isFromIpfs={false}
                          isFromLocal={true}
                          fileFormat={fileFormat}
                          file={file}
                          handleFileDownload={handleFileDownload}
                        />
                      ) : (
                        <div className="flex items-center justify-center w-full h-full">
                          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-50" />
                        </div>
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

export default VideoDialog;
