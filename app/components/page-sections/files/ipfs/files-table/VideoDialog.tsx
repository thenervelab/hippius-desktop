import React, { ReactNode, useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { Video, ChevronLeft, ChevronRight } from "lucide-react";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { Icons } from "@/components/ui";
import { toast } from "sonner";
import { downloadIpfsFile } from "@/lib/utils/downloadIpfsFile";
import VideoPlayer from "./VideoPlayer";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getNextViewableFile, getPrevViewableFile } from "@/app/lib/utils/mediaNavigation";

export const VideoDialogTrigger: React.FC<{
  children: ReactNode;
  onClick: () => void;
}> = ({ children, onClick }) => {
  return (
    <button
      onClick={onClick}
      className="px-4 py-[22px] relative group overflow-hidden flex items-center w-full"
    >
      <span>{children}</span>
      <div className="absolute pointer-events-none right-4 pl-16 bg-gradient-to-r from-transparent translate-x-6 opacity-0 duration-300 group-hover:translate-x-0 group-hover:opacity-100 to-white">
        <Icons.PlayCircle className="size-5 text-primary-60 [&>path]:stroke-[4px]" />
      </div>
    </button>
  );
};

const VideoDialog: React.FC<{
  file: null | FormattedUserIpfsFile;
  allFiles: FormattedUserIpfsFile[];
  onCloseClicked: () => void;
  onNavigate: (file: FormattedUserIpfsFile) => void;
}> = ({ file, allFiles, onCloseClicked, onNavigate }) => {
  const [nextFile, setNextFile] = useState<FormattedUserIpfsFile | null>(null);
  const [prevFile, setPrevFile] = useState<FormattedUserIpfsFile | null>(null);

  // Calculate next and previous files whenever the current file changes
  useEffect(() => {
    if (!file) return;

    const next = getNextViewableFile(file, allFiles);
    const prev = getPrevViewableFile(file, allFiles);

    setNextFile(next);
    setPrevFile(prev);
  }, [file, allFiles]);

  const handleNext = () => {
    if (nextFile) {
      onNavigate(nextFile);
    }
  };

  const handlePrev = () => {
    if (prevFile) {
      onNavigate(prevFile);
    }
  };

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
  }, [file, nextFile, prevFile]);

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
        <Dialog.Overlay className="bg-white/90 fixed p-3 sm:p-10 md:p-20 z-[999] top-0 w-full h-full flex items-center justify-center data-[state=open]:animate-fade-in-0.3 backdrop-blur-xl">
          <Dialog.Content className="h-full max-w-screen-1.5xl max-h-[90vh] text-grey-10 w-full flex flex-col">
            {(() => {
              if (file) {
                const videoUrl = `https://get.hippius.network/ipfs/${decodeHexCid(file.cid)}`;
                const { fileFormat } = getFilePartsFromFileName(file.name);

                return (
                  <>
                    <div className="absolute flex justify-center top-4 px-2 sm:px-6 animate-fade-in-0.3 left-0 right-0">
                      <div className="flex justify-between gap-2 sm:gap-6 w-full ">
                        <Dialog.Title className="data-[state=open] font-medium flex items-center gap-x-2 w-full text-xl">
                          <div className="size-7 bg-primary-80 rounded flex items-center justify-center">
                            <Video className="size-5 text-grey-10" />
                          </div>
                          <span
                            title={file.name}
                            className="truncate max-sm:max-w-[180px]"
                          >
                            {file.name}
                          </span>
                        </Dialog.Title>

                        <div className="flex gap-x-4 items-center">
                          <button
                            onClick={() => {
                              downloadIpfsFile(file);
                            }}
                            className="flex hover:opacity-40 duration-300 text-sm font-medium gap-x-2 items-center bg-white whitespace-nowrap rounded border border-grey-80 p-2"
                          >
                            <Icons.DocumentDownload className="size-4 min-w-4" />
                            <span className="max-sm:hidden">Download File</span>
                          </button>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(videoUrl).then(() => {
                                toast.success("Copied to clipboard successfully!");
                              });
                            }}
                            className="size-9 border hover:opacity-40 duration-300 border-grey-8 flex items-center justify-center rounded"
                          >
                            <Icons.Link className="size-5 [&>path]:stroke-2" />
                          </button>
                          <button
                            className="hover:opacity-40 duration-300"
                            onClick={onCloseClicked}
                          >
                            <Icons.CloseCircle className="size-7 [&>path]:stroke-2 text-grey-10" />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Left navigation button */}
                    {prevFile && (
                      <button
                        onClick={handlePrev}
                        className="absolute left-5 top-1/2 -translate-y-1/2 z-10 bg-white/80 hover:bg-white rounded-full p-3 shadow-lg transition-all duration-300 hover:scale-110"
                        aria-label="Previous video"
                      >
                        <ChevronLeft className="size-7 text-grey-30" />
                      </button>
                    )}

                    {/* Right navigation button */}
                    {nextFile && (
                      <button
                        onClick={handleNext}
                        className="absolute right-5 top-1/2 -translate-y-1/2 z-10 bg-white/80 hover:bg-white rounded-full p-3 shadow-lg transition-all duration-300 hover:scale-110"
                        aria-label="Next video"
                      >
                        <ChevronRight className="size-7 text-grey-30" />
                      </button>
                    )}

                    <div className="border-4 animate-scale-in-95-0.4 shadow-dialog bg-white bottom-0 grow flex w-full h-full flex-col top-8 border-grey-80 bg-background-1 rounded-[8px] overflow-hidden relative data-[state=open]:animate-scale-in-95-0.4">
                      <VideoPlayer
                        videoUrl={videoUrl}
                        fileFormat={fileFormat}
                        file={file}
                      />
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
