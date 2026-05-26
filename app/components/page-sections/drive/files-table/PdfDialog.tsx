import React, { ReactNode, useState, useEffect } from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { Icons } from "@/components/ui";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { Loader2, AlertCircle, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";
import { FileViewerLayout } from "@/app/components/page-sections/drive/file-viewer";

const LOAD_TIMEOUT_MS = 15000;

// WebKitGTK (the webview used by Tauri on Linux) has no built-in PDF
// viewer, so an <iframe> pointed at a PDF will hang silently. We detect
// this up front and offer the system viewer instead of waiting for the
// load timeout to fire.
async function openInSystemViewer(filePath: string) {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(filePath);
  } catch (err) {
    console.error("Failed to open PDF in system viewer:", err);
  }
}

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
      <div className="absolute pointer-events-none opacity-0 transition-opacity duration-300 group-hover:opacity-100 right-4 inset-y-0 flex items-center">
        <Icons.EyeOutline className="size-4 text-primary-60" />
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
  const [isLinux, setIsLinux] = useState(false);
  const { polkadotAddress } = useWalletAuth();

  useEffect(() => {
    let cancelled = false;
    invoke<{ os: string }>("get_platform_info")
      .then((info) => {
        if (!cancelled) setIsLinux(info.os === "linux");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!file) return;
    setLoaded(false);
    setResolvedUrl(getFileUrl(file).url);

    // WebKitGTK has no PDF viewer — short-circuit straight to the error
    // state so the user gets the "Open with System Viewer" path instead
    // of staring at a spinner for 15 seconds.
    if (isLinux) {
      setLoadError(true);
      return;
    }
    setLoadError(false);

    // iframe onError is unreliable for asset protocol failures, so treat
    // a "still not loaded after timeout" state as an error.
    const timeout = setTimeout(() => {
      setLoaded((wasLoaded) => {
        if (!wasLoaded) setLoadError(true);
        return wasLoaded;
      });
    }, LOAD_TIMEOUT_MS);

    return () => clearTimeout(timeout);
  }, [file, isLinux]);

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
              "p-6 w-full max-w-xl mx-auto rounded-[12px]",
              "bg-white/80 dark:bg-black-primary-bg/80 backdrop-blur-sm",
              "border border-grey-dark-100 dark:border-black-300",
            )}
          >
            <AlertCircle className="size-12 mx-auto mb-3 text-red-400" />
            <p className="text-lg font-medium mb-2">
              {isLinux ? "PDF preview not supported on Linux" : "Failed to load PDF"}
            </p>
            <p className="text-sm text-grey-50 dark:text-grey-light-300 mb-6 text-center">
              {isLinux
                ? "The Linux webview has no built-in PDF viewer. Open it with your system viewer instead."
                : "The file could not be displayed. Try downloading it instead."}
            </p>
            <div className="flex flex-row gap-3 flex-nowrap">
              {file.source && (
                <button
                  onClick={() => openInSystemViewer(file.source!)}
                  className="flex items-center gap-x-2 whitespace-nowrap bg-primary-50 hover:bg-primary-70 transition-colors px-4 py-2 rounded-md font-medium text-white"
                >
                  <ExternalLink className="size-5" />
                  <span>Open with System Viewer</span>
                </button>
              )}
              <button
                onClick={() => handleFileDownload(file, polkadotAddress ?? "")}
                className={cn(
                  "flex items-center gap-x-2 whitespace-nowrap rounded-md px-4 py-2 font-medium transition-colors",
                  file.source
                    ? "bg-grey-10 text-white hover:bg-grey-20 dark:bg-grey-20 dark:hover:bg-grey-30"
                    : "bg-primary-50 hover:bg-primary-70 text-white",
                )}
              >
                <Icons.DocumentDownload className="size-5" />
                <span>Download File</span>
              </button>
            </div>
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
