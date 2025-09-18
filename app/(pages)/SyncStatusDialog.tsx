"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Graphsheet } from "@/components/ui";
import * as Icons from "@/components/ui/icons";
import { useState, useEffect, useRef, useCallback, forwardRef } from "react";
import { useAtomValue } from "jotai";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { cn } from "@/lib/utils";
import InfoTooltip from "@/components/ui/info-tooltip";
import FileSyncTypeBadge from "../components/page-sections/files/ipfs/files-table/FileSyncTypeBadge";
import { syncPercentAtom, syncStatusAtom } from "@/app/lib/store/syncAtoms";
import { SyncActivityRow } from "@/lib/hooks/useSyncActivity";
import { getPrivateSyncPath } from "@/lib/utils/syncPathUtils";

// UI constants
const COLLAPSED_HEIGHT = 64;
const EXPANDED_HEIGHT = 460;
const BODY_MAX_HEIGHT = EXPANDED_HEIGHT - COLLAPSED_HEIGHT;

interface SyncStatusDialogProps {
  open: boolean;
  syncFiles: SyncActivityRow[];
  onExpandedChange?: (expanded: boolean) => void;
}

const SyncStatusDialog = forwardRef<HTMLDivElement, SyncStatusDialogProps>(
  ({ open, syncFiles, onExpandedChange }, dialogContentRef) => {
    const fileListRef = useRef<HTMLDivElement>(null);
    const [isExpanded, setIsExpanded] = useState(false);
    const [privateSyncPath, setPrivateSyncPath] = useState<string>("");

    // Get sync percentage and status from atoms
    const syncPercent = useAtomValue(syncPercentAtom);
    const syncStatus = useAtomValue(syncStatusAtom);

    // Load private sync path to determine file types
    useEffect(() => {
      const loadPrivateSyncPath = async () => {
        try {
          const path = await getPrivateSyncPath();
          setPrivateSyncPath(path || "");
        } catch (error) {
          console.error("Failed to load private sync path:", error);
          setPrivateSyncPath("");
        }
      };

      loadPrivateSyncPath();
    }, []);

    const getFileType = useCallback(
      (filePath: string): "private" | "public" | null => {
        if (!filePath || !privateSyncPath) return null;
        return filePath.includes(privateSyncPath) ? "private" : "public";
      },
      [privateSyncPath]
    ); // fade on scroll effect
    useEffect(() => {
      const fileList = fileListRef.current;
      if (!fileList || !isExpanded) return;

      const handleScroll = () => {
        const { clientHeight } = fileList;
        const topFade = 20;
        const bottomFade = 20;
        fileList
          .querySelectorAll<HTMLElement>("[data-file-item]")
          .forEach((el) => {
            const { top, height } = el.getBoundingClientRect();
            const offsetTop = top - fileList.getBoundingClientRect().top;
            const offsetBottom = offsetTop + height;
            if (offsetTop < topFade) {
              el.style.opacity = `${Math.max(0.3, offsetTop / topFade)}`;
            } else if (offsetBottom > clientHeight - bottomFade) {
              el.style.opacity = `${Math.max(
                0.3,
                (clientHeight - offsetTop) / bottomFade
              )}`;
            } else {
              el.style.opacity = "1";
            }
          });
      };
      fileList.addEventListener("scroll", handleScroll);
      return () => fileList.removeEventListener("scroll", handleScroll);
    }, [isExpanded]);

    const toggleExpanded = useCallback(() => {
      setIsExpanded((v) => {
        const newValue = !v;
        onExpandedChange?.(newValue);
        return newValue;
      });
    }, [onExpandedChange]);

    if (!syncFiles?.length && !syncStatus?.in_progress) return null;

    const totalFiles = syncStatus?.total_files || syncFiles.length;
    const syncedFiles =
      syncStatus?.synced_files ||
      syncFiles.filter((f) => f.status === "uploaded").length;
    const percentage = syncPercent !== null ? Math.round(syncPercent) : 0;
    const isCompleted = percentage >= 100;

    // Calculate position based on other dialog states
    const getDialogPosition = () => {
      let rightOffset = "right-4 sm:right-12";
      let bottomOffset = "bottom-20 sm:bottom-7";

      // Sync dialog always stays at the bottom position
      // The unpin dialog will position itself above this one

      return `${rightOffset} ${bottomOffset}`;
    };

    return (
      <Dialog.Root open={open} modal={false}>
        <Dialog.Portal>
          <Dialog.Content
            ref={dialogContentRef}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "fixed z-[2] outline-none shadow-menu rounded-[8px] transition-all duration-300 ease-in-out",
              getDialogPosition(),
              isExpanded ? "w-[378px]" : "w-16 sm:w-[220px]"
            )}
          >
            {/* Header */}
            <div
              className={cn(
                "shadow-menu bg-grey-100 border border-grey-80 cursor-pointer hover:bg-grey-90 transition-all duration-300 ease-in-out",
                isExpanded
                  ? "rounded-t-[8px] w-[378px]"
                  : "rounded-[8px] w-16 sm:w-[220px]"
              )}
              onClick={toggleExpanded}
            >
              <div
                className={cn(
                  "relative flex items-center gap-3 justify-between transition-all duration-300 ease-in-out",
                  isExpanded ? "p-4" : "p-2"
                )}
              >
                <Graphsheet
                  majorCell={{
                    lineColor: [213, 224, 248, 1],
                    lineWidth: 1,
                    cellDim: 100,
                  }}
                  minorCell={{
                    lineColor: [213, 224, 248, 1],
                    lineWidth: 1,
                    cellDim: 20,
                  }}
                  className={cn(
                    "absolute w-full h-full opacity-50 inset-0 transition-opacity duration-300",
                    isExpanded ? "opacity-50" : "opacity-0 sm:opacity-0"
                  )}
                />

                <div className="flex items-center">
                  <div
                    className={cn(
                      "relative transition-all duration-300",
                      isExpanded
                        ? "opacity-0 absolute w-0 overflow-hidden"
                        : "opacity-100 relative size-12"
                    )}
                  >
                    {/* Circular progress indicator - only visible when collapsed */}
                    <svg
                      className="absolute inset-0 w-full h-full -rotate-90 z-10"
                      viewBox="0 0 48 48"
                    >
                      <circle
                        cx="24"
                        cy="24"
                        r="22"
                        className="fill-none stroke-[4] stroke-[#e8eeff]"
                      />
                      <circle
                        cx="24"
                        cy="24"
                        r="22"
                        className={cn(
                          "fill-none stroke-[4]",
                          isCompleted ? "stroke-[#4ade80]" : "stroke-[#4171e0]"
                        )}
                        strokeLinecap="round"
                        strokeDasharray={`${percentage * 1.38} 138`}
                      />
                    </svg>

                    {/* Icon wrapper */}
                    <div className="absolute inset-0 size-12 flex items-center justify-center">
                      <AbstractIconWrapper className="size-10 flex items-center justify-center rounded-[50%]">
                        {isCompleted ? (
                          <Icons.TickCircle className="size-6 relative text-success-50" />
                        ) : (
                          <Icons.Refresh className="size-6 relative text-primary-50 animate-spin" />
                        )}
                      </AbstractIconWrapper>
                    </div>
                  </div>

                  {/* Title - only visible when expanded */}
                  <Dialog.Title
                    className={cn(
                      "flex items-center transition-all duration-300",
                      isExpanded
                        ? "opacity-100 translate-x-0"
                        : "opacity-0 -translate-x-4 absolute"
                    )}
                  >
                    <span className="text-base font-medium text-grey-10">
                      {isCompleted ? "Sync Complete" : "File Sync"}
                    </span>
                    <InfoTooltip className="ml-2">
                      {isCompleted
                        ? "All files have been successfully synced to the network."
                        : "Your files are being synced to the Hippius network. This process may take a few minutes."}
                    </InfoTooltip>
                  </Dialog.Title>
                </div>

                <div
                  className={cn(
                    "flex items-center whitespace-nowrap transition-all duration-300 ease-in-out",
                    isExpanded ? "opacity-100" : "opacity-0 sm:opacity-100"
                  )}
                >
                  <span className="text-sm text-grey-40 mr-2">
                    {isCompleted ? "Complete" : `${percentage}%`}
                  </span>
                  <div className="transition-transform duration-300 ease-in-out">
                    {isExpanded ? (
                      <ChevronDown className="h-5 w-5 text-grey-40" />
                    ) : (
                      <ChevronUp className="h-5 w-5 text-grey-40" />
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Animated body */}
            <div
              className="overflow-hidden transition-[max-height,opacity] duration-300 ease-in-out"
              style={{
                maxHeight: isExpanded ? `${BODY_MAX_HEIGHT}px` : "0px",
                opacity: isExpanded ? 1 : 0,
              }}
            >
              <div className="bg-grey-100 border border-grey-80 rounded-b-[8px] w-[378px] overflow-hidden">
                {/* Status banner */}
                <div className="flex w-full mt-4 ml-4">
                  <div
                    className={cn(
                      "w-fit px-2 py-0.5 border rounded",
                      isCompleted
                        ? "bg-success-100/40 border-success-80"
                        : "bg-primary-100/40 border-primary-80"
                    )}
                  >
                    <div
                      className={cn(
                        "text-sm",
                        isCompleted ? "text-success-40" : "text-primary-40"
                      )}
                    >
                      {syncedFiles} of {totalFiles} files synced
                    </div>
                  </div>
                </div>

                {/* File list */}
                <div
                  ref={fileListRef}
                  className="max-h-[320px] overflow-y-auto p-4"
                >
                  {syncFiles.map((file, index) => {
                    const isFileCompleted = file.status === "uploaded";
                    const isUploading = file.status === "uploading";

                    return (
                      <div
                        key={`${file.id}-${index}`}
                        className="flex items-center justify-between mb-4 last:mb-0 transition-opacity duration-200"
                        data-file-item
                      >
                        <div className="flex items-center gap-2">
                          <AbstractIconWrapper className="size-8 flex items-center justify-center">
                            {file.fileType === "folder" ? (
                              <Icons.BoxSimple2 className="size-5 relative text-primary-50" />
                            ) : (
                              <Icons.Document className="size-5 relative text-primary-50" />
                            )}
                          </AbstractIconWrapper>
                          <div className="flex flex-col justify-center">
                            <div className="flex items-center gap-1 justify-center">
                              <div className="text-sm font-medium text-grey-10 truncate flex items-center gap-2">
                                <span>
                                  {file.fileName.length > 14
                                    ? `${file.fileName.slice(
                                        0,
                                        5
                                      )}...${file.fileName.slice(-7)}`
                                    : file.fileName}
                                </span>
                              </div>
                              <FileSyncTypeBadge
                                type={getFileType(file.scope)}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center">
                          {isFileCompleted ? (
                            <>
                              <Icons.TickCircle className="w-5 h-5 text-success-50" />
                              <span className="text-sm ml-1 text-success-50">
                                Synced
                              </span>
                            </>
                          ) : isUploading ? (
                            <>
                              <div className="animate-spin mr-2">
                                <Icons.Refresh className="w-4 h-4 text-primary-50" />
                              </div>
                              <span className="text-sm text-primary-50">
                                Syncing...
                              </span>
                            </>
                          ) : (
                            <span className="text-sm text-grey-50">
                              Pending
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
);

export default SyncStatusDialog;
