/* eslint-disable @next/next/no-img-element */
import React, { ReactNode, useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { Icons } from "@/components/ui";
import { toast } from "sonner";
import { downloadIpfsFile } from "@/lib/utils/downloadIpfsFile";
import {
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  getNextViewableFile,
  getPrevViewableFile,
} from "@/app/lib/utils/mediaNavigation";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

export const ImageDialogTrigger: React.FC<{
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
        <Icons.Eye className="size-5 text-primary-60 [&>path]:stroke-[3px]" />
      </div>
    </button>
  );
};

const ImageDialog: React.FC<{
  file: null | FormattedUserIpfsFile;
  allFiles: FormattedUserIpfsFile[];
  onCloseClicked: () => void;
  onNavigate: (file: FormattedUserIpfsFile) => void;
}> = ({ file, allFiles, onCloseClicked, onNavigate }) => {
  const { polkadotAddress } = useWalletAuth();
  const [imageLoaded, setImageLoaded] = useState(false);
  const [nextFile, setNextFile] = useState<FormattedUserIpfsFile | null>(null);
  const [prevFile, setPrevFile] = useState<FormattedUserIpfsFile | null>(null);

  // Calculate next and previous files whenever the current file changes
  useEffect(() => {
    if (!file) return;

    const next = getNextViewableFile(file, allFiles);
    const prev = getPrevViewableFile(file, allFiles);

    setNextFile(next);
    setPrevFile(prev);
    setImageLoaded(false);
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
        <Dialog.Overlay className="bg-black/80 fixed p-3 sm:p-10 md:p-20 z-[999] top-0 w-full h-full flex items-center justify-center data-[state=open]:animate-fade-in-0.3">
          <Dialog.Content className="h-full max-w-screen-1.5xl text-grey-10 w-full flex flex-col items-center">
            {(() => {
              if (file) {
                const imageUrl = `https://get.hippius.network/ipfs/${decodeHexCid(
                  file.cid
                )}`;

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
                            className="truncate max-sm:max-w-[180px] text-grey-100 text-[22px] font-medium"
                          >
                            {file.name}
                          </span>
                        </Dialog.Title>

                        <div className="flex gap-x-4 items-center">
                          <button
                            onClick={() => {
                              downloadIpfsFile(file, polkadotAddress ?? "");
                            }}
                            className="flex duration-300 text-sm font-medium gap-x-2 items-center bg-white whitespace-nowrap rounded border border-grey-80 p-2"
                          >
                            <Icons.DocumentDownload className="size-4 min-w-4" />
                            <span className="max-sm:hidden text-grey-10 text-sm">Download File</span>
                          </button>
                          <button
                            onClick={() => {
                              navigator.clipboard
                                .writeText(imageUrl)
                                .then(() => {
                                  toast.success(
                                    "Copied to clipboard successfully!"
                                  );
                                });
                            }}
                            className="size-9 border duration-300 border-grey-8 flex items-center justify-center rounded bg-white"
                          >
                            <Icons.Link className="size-5 [&>path]:stroke-2" />
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
                      <div
                        className={cn(
                          "absolute top-0 left-0 h-full flex items-center justify-center w-full pointer-events-none",
                          imageLoaded && "opacity-0"
                        )}
                      >
                        <Loader2 className="size-6 text-primary-50 animate-spin" />
                      </div>
                      <motion.div
                        layout
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{
                          opacity: imageLoaded ? 1 : 0,
                          scale: imageLoaded ? 1 : 1.0,
                        }}
                        transition={{ duration: 0.3, ease: "easeInOut" }}
                        onClick={(e) => e.stopPropagation()}
                        className="min-w-28 min-h-28 relative shadow-dialog flex max-w-full max-h-full h-fit flex-col rounded overflow-hidden"
                      >
                        <img
                          onLoad={() => {
                            setImageLoaded(true);
                          }}
                          src={imageUrl}
                          alt={file.name}
                          className={cn(
                            "max-h-[80vh] duration-300 opacity-0 max-w-full relative w-auto h-auto object-contain rounded",
                            imageLoaded && "opacity-100"
                          )}
                        />
                      </motion.div>
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
