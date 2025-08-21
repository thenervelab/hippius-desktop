"use client";

import React, { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import Image from "next/image";
import { CardButton, Graphsheet, Icons } from "@/components/ui";
import RevealTextLine from "@/components/ui/reveal-text-line";
import BasicMarkdown from "./BasicMarkdown";

import { toast } from "sonner";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion as getAppVersion } from "@tauri-apps/api/app";
import { CloseCircle } from "../ui/icons";
import { InView } from "react-intersection-observer";

type Props = {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  onClose?: () => void;
};

/* ---------- helpers (bytes/percent) ---------- */
function formatBytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}
function formatPercentage(current: number, total: number): string {
  if (!total) return "0.0";
  return ((current / total) * 100).toFixed(1);
}

export default function CheckForUpdateDialog({
  open,
  onOpenChange,
  onClose,
}: Props) {
  const [status, setStatus] = useState<
    "idle" | "checking" | "available" | "none" | "error"
  >("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");

  // run check() whenever the dialog opens
  useEffect(() => {
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
          setStatus("none");
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

  const handleOpenChange = (o: boolean) => {
    onOpenChange?.(o);
    if (!o) onClose?.();
  };

  // download/install flow (same logic as your function, without notifications)
  const handleUpdateNow = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (!update) return;

    let downloadToastId: string | number | undefined;
    try {
      let totalBytes = 0;
      let downloadedBytes = 0;

      await update.downloadAndInstall((ev) => {
        switch (ev.event) {
          case "Started": {
            totalBytes = ev.data.contentLength ?? 0;
            downloadToastId = toast.loading(
              `Starting download... (${formatBytes(totalBytes)} MB)`,
              {
                description:
                  "0% complete • 0 MB / " + formatBytes(totalBytes) + " MB",
                duration: Infinity,
              }
            );
            break;
          }
          case "Progress": {
            downloadedBytes += ev.data.chunkLength;
            const pct = formatPercentage(downloadedBytes, totalBytes);
            const downloadedMB = formatBytes(downloadedBytes);
            const totalMB = formatBytes(totalBytes);
            const remainingMB = formatBytes(totalBytes - downloadedBytes);
            if (downloadToastId) {
              toast.loading(`Downloading update... ${pct}%`, {
                id: downloadToastId,
                description: `${downloadedMB} MB / ${totalMB} MB • ${remainingMB} MB remaining`,
                duration: Infinity,
              });
            }
            break;
          }
          case "Finished": {
            if (downloadToastId) toast.dismiss(downloadToastId);
            toast.success("Download completed!", {
              description: `${formatBytes(
                totalBytes
              )} MB downloaded successfully`,
              duration: 3000,
            });
            toast.loading("Installing update...", {
              description: "Please wait while the update is being installed",
              duration: Infinity,
            });
            break;
          }
        }
      });

      toast.dismiss();
      toast.success("Update installed successfully!", {
        description: "Application will restart now...",
        duration: 3000,
      });
      await relaunch();
    } catch (err) {
      if (downloadToastId) toast.dismiss(downloadToastId);
      console.error(err);
      toast.error("Update failed", { description: "Please try again later." });
    }
  };

  const isAvailable = status === "available" && !!update;
  const isLatest = status === "none";

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-white/60 z-50" />
        <Dialog.Content
          className="
            fixed left-1/2 top-1/2 z-50 
            w-full max-w-[1100px] h-[calc(100vh-100px)] md:h-[567px]
            -translate-x-1/2 -translate-y-1/2
          "
        >
          <Dialog.Title className="sr-only">
            Download Hippius Desktop App
          </Dialog.Title>

          <div
            className="bg-white rounded-[8px]
                       shadow-[0px_12px_36px_rgba(0,0,0,0.14)]
                       border border-grey-80 mx-6 h-full relative max-md:overflow-y-scroll"
          >
            <div className="absolute top-0 left-0 right-0 h-4 bg-primary-50 rounded-t-[8px] sm:hidden" />
            <Dialog.Close className="max-md:hidden absolute top-4 right-4 border-[0.7px] border-grey-80 flex justify-center items-center size-10 hover:bg-grey-90 transition-colors">
              <X className="size-4 text-grey-10" />
            </Dialog.Close>

            <InView triggerOnce>
              {({ inView, ref }) => (
                <div
                  ref={ref}
                  className="grid grid-cols-1 max-md:p-4 md:grid-cols-2 md:gap-6 lg:gap-12 w-full h-full md:pr-4 items-stretch"
                >
                  {/* Mobile close */}
                  <button
                    aria-label="Close"
                    onClick={onClose}
                    className="text-grey-10 hover:text-grey-20 md:hidden py-4 flex justify-end"
                  >
                    <CloseCircle className="size-6" />
                  </button>

                  <div className="bg-primary-100 md:rounded-tl-lg md:rounded-bl-lg relative h-full max-md:h-[359px]">
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
                          className="object-contain object-center w-[380px] md:scale-110"
                        />
                      </RevealTextLine>
                    </div>
                  </div>

                  {/* RIGHT pane */}
                  <div className="bg-grey-100 flex flex-col md:h-full md:overflow-hidden my-9 md:my-0 pr-2 md:pr-4 pb-6">
                    {/* header icon */}
                    <div className="shrink-0">
                      <div className="flex items-center mt-9">
                        <div className="flex items-center justify-center h-[56px] w-[56px] relative">
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
                          <div className="flex items-center justify-center size-8 bg-primary-50 rounded-[8px] relative">
                            <Icons.HippiusLogo className="size-5 text-white" />
                          </div>
                        </div>
                      </div>

                      {/* headline section */}
                      {isAvailable && (
                        <>
                          <div className="mt-6">
                            <RevealTextLine rotate reveal className="delay-200">
                              <span className="text-success-50 font-geist text-base lg:text-[18px]">
                                Update Available
                              </span>
                            </RevealTextLine>
                          </div>

                          <h1 className="text-[28px] lg:text-[40px] leading-[48px] text-grey-10 mt-2">
                            <RevealTextLine rotate reveal className="delay-300">
                              <span className="font-medium text-grey-30">
                                New Update Available -
                              </span>
                            </RevealTextLine>
                            <br />
                            <RevealTextLine rotate reveal className="delay-400">
                              <span className="text-primary-40 font-semibold">
                                Install Now
                              </span>
                            </RevealTextLine>
                          </h1>

                          <RevealTextLine rotate reveal className="delay-500">
                            <p className="text-grey-60 font-medium text-base mt-2">
                              Version {update?.version} is now available for
                              download.
                            </p>
                          </RevealTextLine>
                        </>
                      )}

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

                      {(isLatest || status === "error") && (
                        <>
                          <div className="mt-24">
                            <span className="text-success-50 font-geist text-base lg:text-[18px]">
                              You’re on the latest version
                            </span>
                          </div>

                          <h1 className="text-[28px] lg:text-[40px] leading-[48px] text-grey-10 mt-2">
                            No update is available at the moment.
                          </h1>

                          <p className="text-grey-60 font-medium text-base mt-2">
                            Check again later to stay current.
                          </p>

                          {currentVersion && (
                            <p className="text-grey-70 text-sm mt-4">
                              Version {currentVersion}
                            </p>
                          )}
                        </>
                      )}
                    </div>

                    {/* Release notes */}
                    {isAvailable && update?.body && (
                      <div className="flex-1 min-h-0 mt-4">
                        <div className="flex items-center gap-2 text-grey-50 font-medium">
                          <Icons.Note2 className="size-6" />
                          <span className="text-lg">Release Notes</span>
                        </div>
                        <div className="h-full overflow-y-auto pr-1 md:pr-3 pb-4">
                          <BasicMarkdown text={update.body} />
                        </div>
                      </div>
                    )}

                    {/* CTA */}
                    {isAvailable && (
                      <div className="shrink-0 flex flex-col gap-4 mt-10">
                        <CardButton
                          variant="dialog"
                          className="w-[208px] h-[48px] py-4 text-base"
                          onClick={handleUpdateNow}
                        >
                          Update Now
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
