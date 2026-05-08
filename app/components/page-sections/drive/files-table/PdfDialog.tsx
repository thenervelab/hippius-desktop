import React, { ReactNode, useState, useEffect, useCallback, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { Icons } from "@/components/ui";
import {
  getNextViewableFile,
  getPrevViewableFile,
  getViewableFilePosition
} from "@/app/lib/utils/mediaNavigation";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";

const LOAD_TIMEOUT_MS = 15000;

export const PdfDialogTrigger: React.FC<{
  children: ReactNode;
  onClick: () => void;
}> = ({ children, onClick }) => {
  return (
    <button
      onClick={onClick}
      className="px-2 py-[5px] relative group overflow-hidden flex items-center w-full"
    >
      <span className="flex-1 min-w-0">{children}</span>
      {/* Eye icon on hover */}
      <div className="absolute pointer-events-none pl-16 bg-gradient-to-r from-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100 to-white dark:to-black-300 right-4 inset-y-0 flex items-center">
        <Icons.Eye className="size-5 text-primary-60 [&>path]:stroke-[0.1875rem]" />
      </div>
    </button>
  );
};

const PdfDialog: React.FC<{
  file: null | FormattedUserFile;
  allFiles: FormattedUserFile[];
  onCloseClicked: () => void;
  onNavigate: (file: FormattedUserFile) => void;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string
  ) => void;
}> = ({ file, allFiles, onCloseClicked, onNavigate, handleFileDownload }) => {
  const [nextFile, setNextFile] = useState<FormattedUserFile | null>(null);
  const [prevFile, setPrevFile] = useState<FormattedUserFile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [resolvedUrl, setResolvedUrl] = useState<string>("");
  const [position, setPosition] = useState<{ current: number; total: number } | null>(null);
  const { polkadotAddress } = useWalletAuth();

  // Track the current file to prevent race conditions
  const currentFileRef = React.useRef<FormattedUserFile | null>(null);

  // All files are private — only navigate between locally synced files
  const navigationOptions = useMemo(() => ({ localOnly: true }), []);

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
    setLoaded(false);
    setLoadError(false);

    const result = getFileUrl(file);
    setResolvedUrl(result.url);

    // Fallback: iframe onError is unreliable for asset protocol failures,
    // so treat it as an error if still not loaded after timeout
    const timeout = setTimeout(() => {
      if (currentFileRef.current === file) {
        setLoaded((wasLoaded) => {
          if (!wasLoaded) setLoadError(true);
          return wasLoaded;
        });
      }
    }, LOAD_TIMEOUT_MS);

    return () => clearTimeout(timeout);
  }, [file]);

  const handleNext = useCallback(() => {
    if (nextFile) onNavigate(nextFile);
  }, [nextFile, onNavigate]);

  const handlePrev = useCallback(() => {
    if (prevFile) onNavigate(prevFile);
  }, [prevFile, onNavigate]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!file) return;

      if (e.key === "ArrowRight" && nextFile) handleNext();
      else if (e.key === "ArrowLeft" && prevFile) handlePrev();
      else if (e.key === "Escape") onCloseClicked();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [file, nextFile, prevFile, onCloseClicked, handleNext, handlePrev]);

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
        if (!o) onCloseClicked();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="bg-black/80 fixed inset-0 pt-8 sm:pt-10 md:pt-20 p-3 sm:p-10 md:p-20 z-[999] flex items-center justify-center overflow-hidden data-[state=open]:animate-fade-in-0.3">
          <Dialog.Content className="h-full max-w-screen-1.5xl text-grey-10 w-full flex flex-col items-center">
            {file && (
              <>
                <div className="absolute flex justify-center top-4 px-2 sm:px-6 animate-fade-in-0.3 left-0 right-0">
                  <div className="flex justify-between gap-2 sm:gap-6 w-full ">
                    <Dialog.Title className="data-[state=open] font-medium flex items-center gap-x-2 w-full text-xl">
                      <div className="rounded flex items-center justify-center">
                        <Icons.PDF className="size-8 text-[#ea4335]" />
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



                      <button className="duration-300" onClick={onCloseClicked}>
                        <Icons.CloseCircle className="size-7 [&>path]:stroke-2 text-grey-100" />
                      </button>
                    </div>
                  </div>
                </div>

                {prevFile && (
                  <button
                    onClick={handlePrev}
                    className="absolute left-5 top-1/2 -translate-y-1/2 z-10 border border-grey-80 bg-white/80 hover:bg-white rounded-full p-3 shadow-lg transition-all duration-300 hover:scale-110"
                    aria-label="Previous PDF"
                  >
                    <Icons.ArrowLeft2 className="size-6 text-grey-50" />
                  </button>
                )}

                {nextFile && (
                  <button
                    onClick={handleNext}
                    className="absolute right-5 top-1/2 -translate-y-1/2 z-10 border border-grey-80 bg-white/80 hover:bg-white rounded-full p-3 shadow-lg transition-all duration-300 hover:scale-110"
                    aria-label="Next PDF"
                  >
                    <Icons.ArrowRight2 className="size-6 text-grey-50" />
                  </button>
                )}

                <div
                  onClick={onCloseClicked}
                  className="w-full h-full flex items-center justify-center"
                >
                  {/* loader */}
                  {!loaded && !loadError && (
                    <div className="absolute top-0 left-0 h-full flex items-center justify-center w-full pointer-events-none">
                      <Loader2 className="size-6 text-primary-50 animate-spin" />
                    </div>
                  )}

                  {/* error state */}
                  {loadError && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="flex flex-col items-center justify-center text-white p-6 w-full max-w-md mx-auto bg-black/70 backdrop-blur-sm rounded-lg"
                    >
                      <AlertCircle className="size-12 mx-auto mb-3 text-red-400" />
                      <p className="text-lg font-medium mb-2">Failed to load PDF</p>
                      <p className="text-sm text-gray-300 mb-6 text-center">
                        The file could not be displayed. Try downloading it instead.
                      </p>
                      <button
                        onClick={() => handleFileDownload(file, polkadotAddress ?? "")}
                        className="flex items-center gap-x-2 bg-primary-50 hover:bg-primary-70 transition-colors px-4 py-2 rounded-md font-medium"
                      >
                        <Icons.DocumentDownload className="size-5" />
                        <span>Download File Instead</span>
                      </button>
                    </div>
                  )}

                  {/* PDF iframe */}
                  {resolvedUrl && !loadError && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className={cn(
                        "relative shadow-dialog flex w-full h-full flex-col rounded overflow-hidden animate-scale-in-95-0.4",
                        !loaded && "invisible"
                      )}
                    >
                      <iframe
                        key={resolvedUrl}
                        src={resolvedUrl}
                        width="100%"
                        height="100%"
                        className="border-none"
                        onLoad={() => setLoaded(true)}
                        onError={() => setLoadError(true)}
                      />
                    </div>
                  )}
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default PdfDialog;
