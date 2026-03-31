"use client";

import React, { useState, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle } from "@/components/ui/icons";
import { X } from "lucide-react";
import Image from "next/image";
import { CardButton, Graphsheet, Icons } from "@/components/ui";
import { useAtomValue, useSetAtom } from "jotai";
import {
  updateStore,
  updateDialogOpenAtom,
  confirmUpdate,
  closeUpdateDialog,
} from "@/app/components/updater/updateStore";
import RevealTextLine from "@/components/ui/reveal-text-line";
import { InView } from "react-intersection-observer";
import BasicMarkdown from "./BasicMarkdown";
import { toast } from "sonner";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion as getAppVersion } from "@tauri-apps/api/app";

type Props = { onClose?: () => void };

/* ---------- helpers (bytes/percent) ---------- */
function formatBytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

/* ---------- Progress Bar Component ---------- */
interface ProgressBarProps {
  progress: number;
  className?: string;
}

function ProgressBar({ progress, className = "" }: ProgressBarProps) {
  // Divide progress into 5 segments
  const segments = 5;

  return (
    <div className={`flex gap-1 ${className}`}>
      {Array.from({ length: segments }, (_, i) => {
        const segmentFill = Math.max(0, Math.min(100, (progress - i * 20) * 5));
        return (
          <div
            key={i}
            className="h-3 bg-grey-90 rounded-sm flex-1 overflow-hidden"
          >
            <div
              className="h-full bg-primary-50 transition-all duration-300 ease-out"
              style={{ width: `${segmentFill}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function useDesktopAppDialog() {
  const open = useAtomValue(updateDialogOpenAtom, { store: updateStore });
  const setOpen = useSetAtom(updateDialogOpenAtom, { store: updateStore });
  const closeDialog = () => {
    closeUpdateDialog();
  };
  return { open, setOpen, closeDialog };
}

export default function DesktopAppDownloadDialog({ onClose }: Props) {
  const { open, closeDialog } = useDesktopAppDialog();

  // Progress tracking states
  const [status, setStatus] = useState<
    "checking" | "available" | "downloading" | "installing" | "complete" | "restarting" | "error"
  >("checking");
  const [update, setUpdate] = useState<Update | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [installProgress, setInstallProgress] = useState<number>(0);
  const [downloadedBytes, setDownloadedBytes] = useState<number>(0);
  const [totalBytes, setTotalBytes] = useState<number>(0);

  // Track if update is in progress to prevent dialog closing
  const isUpdateInProgress = status === "downloading" || status === "installing" || status === "complete" || status === "restarting";

  // Use refs to avoid closure issues in async callbacks
  const downloadedBytesRef = useRef<number>(0);
  const totalBytesRef = useRef<number>(0);

  // Check for updates when dialog opens
  React.useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!open) return;
      setStatus("checking");
      try {
        const [u, ver] = await Promise.all([
          check(),
          getAppVersion().catch(() => ""),
        ]);
        if (cancelled) return;
        setCurrentVersion(ver || "");
        if (u) {
          setUpdate(u);
          setStatus("available");
        } else {
          setUpdate(null);
          setStatus("error"); // No update available
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleClose = () => {
    // Prevent closing during update process
    if (isUpdateInProgress) {
      console.log('Update in progress, cannot close dialog');
      return;
    }

    closeDialog();
    confirmUpdate(false);
    console.log('Update dialog closed by user');
    onClose?.();
  };

  // Simulate installation progress in 5 phases
  const simulateInstallation = async () => {
    const phases = [20, 40, 60, 80, 100];
    for (let i = 0; i < phases.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      setInstallProgress(phases[i]);
    }
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    console.log('User clicked Update Now');

    // Don't close dialog, show progress instead
    if (!update) return;

    try {
      setStatus("downloading");
      setDownloadProgress(0);
      setDownloadedBytes(0);
      setTotalBytes(0);

      // Reset refs
      downloadedBytesRef.current = 0;
      totalBytesRef.current = 0;

      await update.downloadAndInstall((ev) => {
        switch (ev.event) {
          case "Started": {
            const total = ev.data.contentLength ?? 0;
            totalBytesRef.current = total;
            setTotalBytes(total);
            downloadedBytesRef.current = 0;
            setDownloadedBytes(0);
            setDownloadProgress(0);
            console.log("Download started, total bytes:", total);
            break;
          }
          case "Progress": {
            downloadedBytesRef.current += ev.data.chunkLength;
            setDownloadedBytes(downloadedBytesRef.current);

            const progress = totalBytesRef.current > 0
              ? (downloadedBytesRef.current / totalBytesRef.current) * 100
              : 0;

            const roundedProgress = Math.min(Math.round(progress), 100);
            setDownloadProgress(roundedProgress);

            console.log(`Download progress: ${roundedProgress}% (${downloadedBytesRef.current}/${totalBytesRef.current})`);
            break;
          }
          case "Finished": {
            setDownloadProgress(100);
            console.log("Download finished, starting installation");
            setStatus("installing");
            simulateInstallation();
            break;
          }
        }
      });

      setStatus("complete");

    } catch (error) {
      console.error("Update process failed:", error);
      setStatus("error");
      toast.error("Update failed", { description: "Please try again later." });
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !isUpdateInProgress && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/20 backdrop-blur-sm z-[9999]" />
        <Dialog.Content
          className="
            fixed left-1/2 top-1/2 z-[10000] 
            w-full max-w-[68.75rem] h-[calc(100vh-100px)] md:h-[41.6875rem]
            -translate-x-1/2 -translate-y-1/2
          "
        >
          <Dialog.Title className="sr-only">
            Download Hippius Desktop App
          </Dialog.Title>

          <div
            className="bg-white rounded-[0.5rem]
                       shadow-[0px_12px_36px_rgba(0,0,0,0.14)]
                       border border-grey-80 mx-6 h-full relative max-md:overflow-y-scroll"
          >
            <div className="absolute top-0 left-0 right-0 h-4 bg-primary-50 rounded-t-[0.5rem] sm:hidden" />
            {!isUpdateInProgress && (
              <Dialog.Close className="max-md:hidden absolute top-4 right-4 border-[0.7px] border-grey-80 flex justify-center items-center size-10 hover:bg-grey-90 transition-colors">
                <X className="size-4 text-grey-10" />
              </Dialog.Close>
            )}

            <InView triggerOnce>
              {({ inView, ref }) => (
                <div
                  ref={ref}
                  className="grid grid-cols-1 max-md:p-4 md:grid-cols-2 md:gap-6 lg:gap-12 w-full h-full md:pr-4 items-stretch"
                >
                  {/* Mobile close */}
                  {!isUpdateInProgress && (
                    <button
                      aria-label="Close"
                      onClick={handleClose}
                      className="text-grey-10 hover:text-grey-20 md:hidden py-4 flex justify-end"
                    >
                      <CloseCircle className="size-6" />
                    </button>
                  )}

                  {/* LEFT: image pane */}
                  <div className="bg-primary-100 md:rounded-tl-lg md:rounded-bl-lg relative h-full max-md:h-[22.4375rem]">
                    <div className="absolute w-full top-0 h-full opacity-5">
                      <Graphsheet
                        majorCell={{
                          lineColor: [31, 80, 189, 1.0],
                          lineWidth: 2,
                          cellDim: 150,
                        }}
                        minorCell={{
                          lineColor: [49, 103, 211, 1.0],
                          lineWidth: 1,
                          cellDim: 15,
                        }}
                        className="absolute w-full left-0 h-full duration-500"
                      />
                    </div>
                    <div className="relative w-full h-full">
                      <RevealTextLine
                        rotate
                        reveal={inView}
                        parentClassName="w-full h-full"
                        className="delay-200 w-full h-full overflow-hidden"
                      >
                        <Image
                          src="/desktop-app-homepage.png"
                          alt="Desktop App frontend view"
                          fill
                          className="object-contain object-center w-[23.75rem] md:scale-110"
                        />
                      </RevealTextLine>
                    </div>
                  </div>

                  {/* RIGHT: content pane (fixed height, only notes scroll) */}
                  <div className="bg-grey-100 flex flex-col md:h-full md:overflow-hidden my-9 md:my-0 pr-2 md:pr-4 pb-6">
                    {/* header icon */}
                    <div className="shrink-0">
                      <div className="flex items-center mt-9">
                        <div className="flex items-center justify-center h-[3.5rem] w-[3.5rem] relative">
                          <Graphsheet
                            majorCell={{
                              lineColor: [31, 80, 189, 1],
                              lineWidth: 2,
                              cellDim: 40,
                            }}
                            minorCell={{
                              lineColor: [31, 80, 189, 1],
                              lineWidth: 2,
                              cellDim: 40,
                            }}
                            className="absolute w-full h-full top-0 bottom-0 left-0 duration-300 opacity-10 block"
                          />
                          <div className="flex items-center justify-center size-8 bg-primary-50 rounded-[0.5rem] relative">
                            <Icons.HippiusLogo className="size-5 text-white" />
                          </div>
                        </div>
                      </div>

                      {/* Checking state */}
                      {status === "checking" && (
                        <div
                          className="mt-40"
                          role="status"
                          aria-live="polite"
                          aria-label="Checking for updates"
                        >
                          <div className="flex items-center gap-3">
                            <span
                              aria-hidden="true"
                              className="inline-block size-6 rounded-full border-2 border-grey-90 border-t-primary-50 animate-spin"
                            />
                            <span className="text-grey-50">
                              Checking for updates…
                            </span>
                          </div>
                        </div>
                      )}

                      {/* headline section - Update Available */}
                      {status === "available" && (
                        <>
                          <div className="mt-6">
                            <RevealTextLine
                              rotate
                              reveal={inView}
                              className="delay-200"
                            >
                              <span className="text-success-50 font-geist text-base lg:text-[1.125rem]">
                                Update Available
                              </span>
                            </RevealTextLine>
                          </div>

                          <h1 className="text-[1.75rem] lg:text-[2.5rem] leading-[3rem] text-grey-10 mt-2">
                            <RevealTextLine
                              rotate
                              reveal={inView}
                              className="delay-300"
                            >
                              <span className="font-medium text-grey-30">
                                New Update Available -
                              </span>
                            </RevealTextLine>
                            <br />
                            <RevealTextLine
                              rotate
                              reveal={inView}
                              className="delay-400"
                            >
                              <span className="text-primary-40 font-semibold">
                                Install Now
                              </span>
                            </RevealTextLine>
                          </h1>

                          <RevealTextLine
                            rotate
                            reveal={inView}
                            className="delay-500"
                          >
                            <p className="text-grey-60 font-medium text-base mt-2">
                              Version {update?.version} is now
                              available for download.
                            </p>
                          </RevealTextLine>
                        </>
                      )}

                      {/* Downloading state */}
                      {status === "downloading" && (
                        <>
                          <div className="mt-24 flex items-center gap-2">
                            <Icons.Refresh className="size-5 text-warning-50 animate-spin" />
                            <span className="text-warning-50 font-geist text-lg">
                              Update In Progress
                            </span>
                          </div>

                          <h1 className="text-[2.5rem] leading-[3rem] text-grey-10 mt-4">
                            Please wait while your update is downloading
                          </h1>

                          <div className="mt-6">
                            <p className="text-grey-50 font-medium text-lg mb-2">
                              Downloading... <span className="text-primary-50">{Math.round(downloadProgress)}%</span>
                            </p>
                            <ProgressBar progress={downloadProgress} />

                            {/* Show download details if available */}
                            {totalBytes > 0 && (
                              <p className="text-grey-50 text-sm mt-2">
                                {formatBytes(downloadedBytes)} MB / {formatBytes(totalBytes)} MB
                              </p>
                            )}
                          </div>
                        </>
                      )}

                      {/* Installing state */}
                      {status === "installing" && (
                        <>
                          <div className="mt-24 flex items-center gap-2">
                            <Icons.Refresh className="size-5 text-warning-50 animate-spin" />
                            <span className="text-warning-50 font-geist text-lg">
                              Update In Progress
                            </span>
                          </div>

                          <h1 className="text-[2.5rem] leading-[3rem] text-grey-40 mt-2">
                            Please wait while your update is installing
                          </h1>

                          <div className="mt-6">
                            <p className="text-grey-60 font-medium text-lg mb-2">
                              Installing... <span className="text-primary-50">{installProgress}%</span>
                            </p>
                            <ProgressBar progress={installProgress} />
                          </div>
                        </>
                      )}

                      {/* Complete state */}
                      {status === "complete" && (
                        <>
                          <div className="mt-24 flex items-center gap-2">
                            <Icons.TickCircle className="size-5 text-success-50" />
                            <span className="text-success-50 font-geist text-lg">
                              Update Complete
                            </span>
                          </div>

                          <h1 className="text-[2.5rem] leading-[3rem] text-grey-40 mt-2">
                            Update is now complete. Please restart the app to use the new version.
                          </h1>

                          <div className="mt-6">
                            <p className="text-grey-50 font-medium text-lg mb-2">
                              Installation Complete <span className="text-primary-50">100%</span>
                            </p>
                            <ProgressBar progress={100} />
                          </div>
                        </>
                      )}

                      {/* Restarting state */}
                      {status === "restarting" && (
                        <>
                          <div className="mt-24 flex items-center gap-2">
                            <Icons.TickCircle className="size-5 text-success-50" />
                            <span className="text-success-50 font-geist text-lg">
                              Update Complete
                            </span>
                          </div>

                          <h1 className="text-[1.75rem] lg:text-[2.5rem] leading-[3rem] text-grey-40 mt-2">
                            Update is now complete. Restarting app...
                          </h1>

                          <div className="mt-6">
                            <p className="text-grey-60 font-medium text-lg mb-2">
                              Installing... <span className="text-primary-50">100%</span>
                            </p>
                            <ProgressBar progress={100} />
                          </div>
                        </>
                      )}

                      {/* Error state */}
                      {status === "error" && (
                        <>
                          <div className="mt-24">
                            <span className="text-error-50 font-geist text-base lg:text-[1.125rem]">
                              {update ? "Update Failed" : "No Update Available"}
                            </span>
                          </div>

                          <h1 className="text-[1.75rem] lg:text-[2.5rem] leading-[3rem] text-grey-10 mt-2">
                            {update
                              ? "Something went wrong during the update process."
                              : "No update is available at the moment."}
                          </h1>

                          <p className="text-grey-60 font-medium text-base mt-2">
                            {update
                              ? "Please try again later."
                              : "Check again later to stay current."}
                          </p>

                          {currentVersion && (
                            <p className="text-grey-70 text-sm mt-4">
                              Current Version: {currentVersion}
                            </p>
                          )}
                        </>
                      )}
                    </div>

                    {/* Release notes: heading static, body scrolls */}
                    {status === "available" && update?.body && (
                      <div className="flex-1 min-h-0 mt-4">
                        <div className="flex items-center gap-2 text-grey-50 font-medium">
                          <Icons.Note2 className="size-6" />
                          <span className="text-lg">Release Notes</span>
                        </div>

                        {/* Only this scrolls */}
                        <div className="h-full overflow-y-auto pr-1 md:pr-3 pb-4">
                          <BasicMarkdown text={update.body} />
                        </div>
                      </div>
                    )}

                    {/* CTA - Update Now button */}
                    {status === "available" && (
                      <div className="shrink-0 flex flex-col gap-4 mt-10">
                        <RevealTextLine
                          rotate
                          reveal={inView}
                          className="delay-800"
                        >
                          <CardButton
                            variant="dialog"
                            className="w-[13rem] h-[3rem] py-4 text-base"
                            onClick={handleDownload}
                          >
                            Update Now
                          </CardButton>
                        </RevealTextLine>
                      </div>
                    )}

                    {/* CTA - Restart Now button */}
                    {status === "complete" && (
                      <div className="shrink-0 flex flex-col gap-2 mt-10">
                        <CardButton
                          variant="dialog"
                          className="w-[13rem] h-[3rem] py-4 text-base"
                          onClick={() => {
                            try {
                              relaunch();
                            } catch (err) {
                              console.error("Restart failed:", err);
                              toast.error("Unable to restart the app. Please restart manually.");
                            }
                          }}
                        >
                          Restart Now
                        </CardButton>
                        <p className="text-grey-60 text-sm">
                          Click the button above to restart and use the new version
                        </p>
                      </div>
                    )}

                    {/* CTA - Try Again button */}
                    {status === "error" && (
                      <div className="shrink-0 flex flex-col gap-4 mt-10">
                        <CardButton
                          variant="dialog"
                          className="w-[13rem] h-[3rem] py-4 text-base"
                          onClick={async () => {
                            // Reset all state and recheck for updates
                            setStatus("checking");
                            setDownloadProgress(0);
                            setInstallProgress(0);
                            setDownloadedBytes(0);
                            setTotalBytes(0);
                            setUpdate(null);

                            try {
                              const [u, ver] = await Promise.all([
                                check(),
                                getAppVersion().catch(() => ""),
                              ]);
                              setCurrentVersion(ver || "");
                              if (u) {
                                setUpdate(u);
                                setStatus("available");
                              } else {
                                setUpdate(null);
                                setStatus("error");
                              }
                            } catch {
                              setStatus("error");
                            }
                          }}
                        >
                          {update ? "Try Again" : "Check for Updates"}
                        </CardButton>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </InView>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
