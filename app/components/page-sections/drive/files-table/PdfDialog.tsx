import React, { ReactNode, useState, useEffect } from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { Icons } from "@/components/ui";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { Loader2, AlertCircle, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { useViewableFileUrl } from "@/app/lib/hooks/useViewableFileUrl";
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
  // The hover eye icon lives inside NameCell (inline, left of the status
  // badge) and reveals via this button's `group` class — an absolute overlay
  // here would fade in on top of the Pending/Failed pills.
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
  onDelete?: (file: FormattedUserFile) => void;
}> = ({
  file,
  allFiles,
  onCloseClicked,
  onNavigate,
  handleFileDownload,
  onDelete,
}) => {
  const [loaded, setLoaded] = useState(false);
  const [iframeFailed, setIframeFailed] = useState(false);
  const [isLinux, setIsLinux] = useState(false);
  const { polkadotAddress } = useWalletAuth();
  // Local URL for synced files; on-demand cloud decrypt for files that aren't
  // on disk (sidebar-search results that live only on the server). `localPath`
  // is the raw path behind the URL, used for "Open with System Viewer".
  const {
    url: resolvedUrl,
    localPath,
    isLoading: resolving,
    error: resolveError,
  } = useViewableFileUrl(file);

  // The error surface covers three causes: the Linux webview has no PDF
  // viewer, the cloud download/decrypt failed, or the iframe never loaded.
  const showError = isLinux || !!resolveError || iframeFailed;

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

  // Reset the iframe load state whenever the resolved URL changes (new file,
  // or a just-finished cloud decrypt).
  useEffect(() => {
    setLoaded(false);
    setIframeFailed(false);
  }, [resolvedUrl]);

  // iframe onError is unreliable for asset-protocol failures, so treat a
  // "still not loaded after timeout" state as an error. Skipped on Linux
  // (no PDF viewer) and until we actually have a URL to load.
  useEffect(() => {
    if (isLinux || !resolvedUrl) return;
    const timeout = setTimeout(() => {
      setLoaded((wasLoaded) => {
        if (!wasLoaded) setIframeFailed(true);
        return wasLoaded;
      });
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [resolvedUrl, isLinux]);

  if (!file) return null;

  return (
    <FileViewerLayout
      file={file}
      allFiles={allFiles}
      onClose={onCloseClicked}
      onNavigate={onNavigate}
      handleFileDownload={handleFileDownload}
      onDelete={onDelete}
    >
      <div className="relative w-full h-full min-h-0 min-w-0 flex items-center justify-center">
        {!loaded && !showError && (resolvedUrl || resolving) && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Loader2 className="size-6 text-primary-50 animate-spin" />
          </div>
        )}

        {showError && (
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
                : (resolveError ??
                  "The file could not be displayed. Try downloading it instead.")}
            </p>
            <div className="flex flex-row gap-3 flex-nowrap">
              {localPath && (
                <button
                  onClick={() => openInSystemViewer(localPath)}
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
                  localPath
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

        {resolvedUrl && !showError && (
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
              onError={() => setIframeFailed(true)}
            />
          </div>
        )}
      </div>
    </FileViewerLayout>
  );
};

export default PdfDialog;
