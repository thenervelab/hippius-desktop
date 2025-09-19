"use client";

import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { Graphsheet } from "@/components/ui";
import * as Icons from "@/components/ui/icons";
import { useState, useEffect, useRef, useCallback } from "react";
import { useAtomValue } from "jotai";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import {
  cn,
  getFilePartsFromFileName,
  getFileTypeFromExtension,
} from "@/lib/utils";
import InfoTooltip from "@/components/ui/info-tooltip";
import FileSyncTypeBadge from "../components/page-sections/files/ipfs/files-table/FileSyncTypeBadge";
import { syncPercentAtom, syncStatusAtom } from "@/app/lib/store/syncAtoms";
import { SyncActivityRow } from "@/lib/hooks/useSyncActivity";
import { formatBytes } from "@/lib/utils/formatBytes";
import { getFileIcon } from "../lib/utils/fileTypeUtils";
import { toast } from "sonner";
const TinyIconBadge: React.FC<{
  title: string;
  variant: "added" | "removed";
  children: React.ReactNode;
}> = ({ title, variant, children }) => (
  <span
    title={title}
    aria-label={title}
    className={cn(
      "inline-flex items-center justify-center w-5 h-5 rounded border",
      " bg-grey-95",
      variant === "added" ? "border-success-50" : "border-error-80"
    )}
  >
    <span
      className={cn(
        "inline-flex",
        variant === "added" ? "text-success-50" : "text-error-60"
      )}
    >
      {children}
    </span>
  </span>
);

// UI constants
const COLLAPSED_HEIGHT = 64;
const EXPANDED_HEIGHT = 460;
const BODY_MAX_HEIGHT = EXPANDED_HEIGHT - COLLAPSED_HEIGHT;

interface SyncStatusDialogProps {
  open: boolean;
  syncFiles: SyncActivityRow[];
  onClose?: () => void;
}

const SyncStatusDialog: React.FC<SyncStatusDialogProps> = ({
  open,
  syncFiles,
  onClose,
}) => {
  const fileListRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  // Get sync percentage and status from atoms
  const syncPercent = useAtomValue(syncPercentAtom);
  const syncStatus = useAtomValue(syncStatusAtom);

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
      return newValue;
    });
  }, []);

  if (!syncFiles?.length && !syncStatus?.in_progress) return null;

  const totalFiles = syncStatus?.total_files || syncFiles.length;
  const syncedFiles =
    syncStatus?.synced_files ||
    syncFiles.filter((f) => f.status === "uploaded").length;
  const percentage = syncPercent !== null ? Math.round(syncPercent) : 0;
  const isCompleted = percentage >= 100;
  const handleHeaderClick = useCallback(
    (e: React.MouseEvent) => {
      const el = e.target as Element;
      if (el.closest('[data-role="close-button"]')) return;
      toggleExpanded();
    },
    [toggleExpanded]
  );
  if (!open) return null;

  return (
    <div
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      className={cn(
        " outline-none shadow-menu rounded-[8px] transition-all duration-300 ease-in-out",
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
        onClick={handleHeaderClick}
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
            <h2
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
            </h2>
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

            {/* Divider to separate actions */}

            {/* Close button - only shown when completed and expanded */}
            {isCompleted && isExpanded && onClose && (
              <>
                <span className="mx-2 h-5 w-px bg-grey-80" role="separator" />
                <button
                  type="button"
                  aria-label="Close sync status"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    (e.nativeEvent as any).stopImmediatePropagation?.();

                    onClose?.();
                  }}
                  data-role="close-button"
                  className="ml-1 inline-flex items-center justify-center w-7 h-7 rounded-full border border-grey-70 hover:border-danger-60 hover:bg-danger-100/20 transition-colors z-10"
                >
                  <Icons.Close className="w-4 h-4 text-grey-30 pointer-events-none" />
                </button>
              </>
            )}
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
          <div ref={fileListRef} className="max-h-[320px] overflow-y-auto p-4">
            {syncFiles.map((file, index) => {
              const isFileCompleted = file.status === "uploaded";
              const isUploading = file.status === "uploading";
              const { fileFormat } = getFilePartsFromFileName(file.fileName);
              const fileType = getFileTypeFromExtension(fileFormat || null);
              const { icon: Icon, color } = getFileIcon(
                fileType ? fileType : undefined,
                false
              );
              // Check if there are any deleted files in the entire syncFiles array
              const hasDeletedFiles = syncFiles.some((f) => f.deleted);
              return (
                <div
                  key={`${file.id}-${index}`}
                  className="flex items-center justify-between mb-4 last:mb-0 transition-opacity duration-200"
                  data-file-item
                >
                  <div className="flex items-center gap-2">
                    <AbstractIconWrapper className="size-8 flex items-center justify-center">
                      <Icon className={cn("size-5 relative", color)} />
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
                        {file.fileType && (
                          <FileSyncTypeBadge
                            type={file.fileType as "public" | "private"}
                          />
                        )}
                        {file.deleted ? (
                          <TinyIconBadge title="Removed" variant="removed">
                            <Trash2 className="w-3.5 h-3.5 pointer-events-none" />
                          </TinyIconBadge>
                        ) : hasDeletedFiles ? (
                          <TinyIconBadge title="Added" variant="added">
                            <Plus className="w-3.5 h-3.5 pointer-events-none" />
                          </TinyIconBadge>
                        ) : null}
                      </div>
                      {file.size > 0 && (
                        <div className="text-xs text-grey-70 mt-1">
                          {formatBytes(file.size)}
                        </div>
                      )}
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
                      <span className="text-sm text-grey-50">Pending</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SyncStatusDialog;
