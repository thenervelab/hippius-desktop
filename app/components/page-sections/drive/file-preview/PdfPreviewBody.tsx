import React, { useEffect, useState } from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { useViewableFileUrl } from "@/app/lib/hooks/useViewableFileUrl";

import PreviewSurface from "./PreviewSurface";
import { PreviewFallback } from "./PreviewState";

const LOAD_TIMEOUT_MS = 15000;

// WebKitGTK (the webview Tauri uses on Linux) has no built-in PDF viewer, so
// an <iframe> pointed at a PDF hangs silently. We detect the platform up front
// via Rust's `get_platform_info` and offer the system viewer instead of
// waiting for the load timeout to fire.
async function openInSystemViewer(filePath: string) {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(filePath);
  } catch (err) {
    console.error("Failed to open PDF in system viewer:", err);
  }
}

/**
 * PDF renderer body for the unified viewer.
 *
 * Keeps the platform split intact: macOS and Windows render the document in an
 * iframe, Linux goes straight to the honest "no PDF viewer here" state with
 * the system-viewer handoff rather than showing a blank frame.
 */
const PdfPreviewBody: React.FC<{
  file: FormattedUserFile;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string,
  ) => void;
}> = ({ file, handleFileDownload }) => {
  const [loaded, setLoaded] = useState(false);
  const [iframeFailed, setIframeFailed] = useState(false);
  const [isLinux, setIsLinux] = useState(false);
  // Local URL for synced files; on-demand cloud decrypt for files that aren't
  // on disk. `localPath` is the raw path behind the URL, used for
  // "Open with System Viewer".
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

  return (
    <PreviewSurface className="items-center justify-center">
      <div className="relative w-full h-full min-h-0 min-w-0 flex items-center justify-center">
        {!loaded && !showError && (resolvedUrl || resolving) && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Loader2 className="size-6 text-primary-50 animate-spin" />
          </div>
        )}

        {showError && (
          <PreviewFallback
            title={
              isLinux ? "PDF preview not supported on Linux" : "Failed to load PDF"
            }
            description={
              isLinux
                ? "The Linux webview has no built-in PDF viewer. Open it with your system viewer instead."
                : (resolveError ??
                  "The file could not be displayed. Try downloading it instead.")
            }
            file={file}
            handleFileDownload={handleFileDownload}
            onOpenExternally={
              localPath ? () => openInSystemViewer(localPath) : undefined
            }
          />
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
    </PreviewSurface>
  );
};

export default PdfPreviewBody;
