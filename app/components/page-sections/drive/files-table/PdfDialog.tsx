import React, { ReactNode, useState, useEffect } from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { Icons } from "@/components/ui";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";
import { FileViewerLayout } from "@/app/components/page-sections/drive/file-viewer";

const LOAD_TIMEOUT_MS = 15000;

export const PdfDialogTrigger: React.FC<{
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

const PdfDialog: React.FC<{
  file: null | FormattedUserFile;
  allFiles: FormattedUserFile[];
  onCloseClicked: () => void;
  onNavigate: (file: FormattedUserFile) => void;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string,
  ) => void;
}> = ({ file, allFiles, onCloseClicked, onNavigate, handleFileDownload }) => {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [resolvedUrl, setResolvedUrl] = useState<string>("");
  const { polkadotAddress } = useWalletAuth();

  useEffect(() => {
    if (!file) return;
    setLoaded(false);
    setLoadError(false);
    setResolvedUrl(getFileUrl(file).url);

    // iframe onError is unreliable for asset protocol failures, so treat
    // a "still not loaded after timeout" state as an error.
    const timeout = setTimeout(() => {
      setLoaded((wasLoaded) => {
        if (!wasLoaded) setLoadError(true);
        return wasLoaded;
      });
    }, LOAD_TIMEOUT_MS);

    return () => clearTimeout(timeout);
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
        {!loaded && !loadError && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Loader2 className="size-6 text-primary-50 animate-spin" />
          </div>
        )}

        {loadError && (
          <div
            className={cn(
              "flex flex-col items-center justify-center text-grey-10 dark:text-grey-light-100",
              "p-6 w-full max-w-md mx-auto rounded-[12px]",
              "bg-white/80 dark:bg-black-primary-bg/80 backdrop-blur-sm",
              "border border-grey-dark-100 dark:border-black-300",
            )}
          >
            <AlertCircle className="size-12 mx-auto mb-3 text-red-400" />
            <p className="text-lg font-medium mb-2">Failed to load PDF</p>
            <p className="text-sm text-grey-50 dark:text-grey-light-300 mb-6 text-center">
              The file could not be displayed. Try downloading it instead.
            </p>
            <button
              onClick={() => handleFileDownload(file, polkadotAddress ?? "")}
              className="flex items-center gap-x-2 bg-primary-50 hover:bg-primary-70 transition-colors px-4 py-2 rounded-md font-medium text-white"
            >
              <Icons.DocumentDownload className="size-5" />
              <span>Download File Instead</span>
            </button>
          </div>
        )}

        {resolvedUrl && !loadError && (
          <div
            className={cn(
              "relative w-full h-full flex flex-col rounded-[8px] overflow-hidden",
              "shadow-[0_14px_31px_rgba(0,0,0,0.06),0_56px_56px_rgba(0,0,0,0.05)]",
              "animate-scale-in-95-0.4",
              !loaded && "invisible",
            )}
          >
            <iframe
              key={resolvedUrl}
              src={resolvedUrl}
              width="100%"
              height="100%"
              className="border-none bg-white"
              onLoad={() => setLoaded(true)}
              onError={() => setLoadError(true)}
            />
          </div>
        )}
      </div>
    </FileViewerLayout>
  );
};

export default PdfDialog;
