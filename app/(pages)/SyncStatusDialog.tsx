"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
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
import { formatBytes } from "@/lib/utils/formatBytes";
import { getFileIcon } from "../lib/utils/fileTypeUtils";
import { syncEngineHealthAtom, CONNECTIVITY_STATUS_LABELS } from "../lib/store/syncAtoms";
import { type SyncSnapshot } from "../lib/types/syncSnapshot";
import { type SyncActionCounts } from "../lib/store/syncAtoms";

const COLLAPSED_HEIGHT = 64;
const EXPANDED_HEIGHT = 460;
const BODY_MAX_HEIGHT = EXPANDED_HEIGHT - COLLAPSED_HEIGHT;

interface SyncStatusDialogProps {
  snapshot: SyncSnapshot;
  open: boolean;
  onClose?: () => void;
  actionCounts?: SyncActionCounts;
}

const SyncStatusDialog: React.FC<SyncStatusDialogProps> = ({
  snapshot,
  open,
  onClose,
  actionCounts,
}) => {
  const fileListRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const engineHealth = useAtomValue(syncEngineHealthAtom);

  const isUnhealthy = engineHealth.status !== "connected";

  // Derive all display state from the snapshot
  const isInProgress = snapshot.isActive;
  const isRetrying = !snapshot.isActive && snapshot.retryInSecs > 0;
  const isCompleted = !snapshot.isActive && !isRetrying && (snapshot.completedFiles > 0 || snapshot.failedFiles > 0);
  const hasFailed = (snapshot.failedFiles > 0 && isCompleted) || isRetrying;
  const percentage = isInProgress && snapshot.totalFiles > 0 && snapshot.overallPercent === 0 && snapshot.bytesExpected === 0
    ? null
    : snapshot.overallPercent;
  const totalFiles = snapshot.totalFiles;
  const hasActiveSync = snapshot.isActive || isRetrying;
  // True when any file is in an encrypt/decrypt phase (changes colors to yellow)
  const isEncryptingPhase = snapshot.files.some(
    (f) => f.status === "encrypting" || f.status === "decrypting"
  );

  // Live countdown for retry timer
  const [retryCountdown, setRetryCountdown] = useState(0);
  useEffect(() => {
    if (snapshot.retryInSecs <= 0) {
      setRetryCountdown(0);
      return;
    }
    setRetryCountdown(snapshot.retryInSecs);
    const timer = setInterval(() => {
      setRetryCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [snapshot.retryInSecs]);

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

  const handleHeaderClick = useCallback(
    (e: React.MouseEvent) => {
      const el = e.target as Element;
      if (el.closest('[data-role="close-button"]')) return;
      toggleExpanded();
    },
    [toggleExpanded]
  );

  if (!snapshot.files.length && !hasActiveSync && !isCompleted && !isRetrying) return null;
  if (!open) return null;

  // Derive counts for the status banner
  const syncedFiles = snapshot.completedFiles;
  const deletedFiles = snapshot.files.filter(
    (f) => (f.action === "local_delete" || f.action === "remote_delete") && f.status === "completed"
  ).length;

  return (
    <div
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      className={cn(
        " outline-none shadow-menu rounded-[8px] transition-all duration-300 ease-in-out",
        isExpanded ? "w-[378px]" : (isUnhealthy || hasFailed) ? "w-[210px]" : "w-[200px]"
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "shadow-menu bg-grey-100 border border-grey-80 cursor-pointer hover:bg-grey-90 transition-all duration-300 ease-in-out",
          isExpanded
            ? "rounded-t-[8px] w-[378px]"
            : (isUnhealthy || hasFailed) ? "rounded-[8px] w-[210px]" : "rounded-[8px] w-[200px]"
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
              "absolute w-full h-full opacity-50 inset-0 transition-opacity duration-300 pointer-events-none",
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
                  className={cn(
                    "fill-none stroke-[4]",
                    isEncryptingPhase ? "stroke-[#fef3c7]" : "stroke-[#e8eeff]"
                  )}
                />
                <circle
                  cx="24"
                  cy="24"
                  r="22"
                  className={cn(
                    "fill-none stroke-[4]",
                    isUnhealthy || hasFailed
                      ? "stroke-[#ef4444]"
                      : isCompleted
                        ? "stroke-[#4ade80]"
                        : isEncryptingPhase
                          ? "stroke-[#f59e0b]"
                          : "stroke-[#4171e0]"
                  )}
                  strokeLinecap="round"
                  strokeDasharray={isUnhealthy || hasFailed ? "138 138" : isCompleted ? "138 138" : percentage !== null ? `${percentage * 1.38} 138` : "17 138"}
                />
              </svg>

              {/* Icon wrapper */}
              <div className="absolute inset-0 size-12 flex items-center justify-center">
                {isUnhealthy || hasFailed ? (
                  <AbstractIconWrapper className="size-10 flex items-center justify-center rounded-[100%]">
                    <Icons.Close className="size-5 relative text-error-50" />
                  </AbstractIconWrapper>
                ) : (
                  <AbstractIconWrapper className="size-10 flex items-center justify-center rounded-[50%]">
                    {isCompleted ? (
                      <Icons.TickCircle className="size-6 relative text-success-50" />
                    ) : (
                      <Icons.Refresh className={cn("size-6 relative animate-spin", isEncryptingPhase ? "text-warning-50" : "text-primary-50")} />
                    )}
                  </AbstractIconWrapper>
                )}
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
                {isUnhealthy
                  ? CONNECTIVITY_STATUS_LABELS[engineHealth.status as keyof typeof CONNECTIVITY_STATUS_LABELS]
                  : isRetrying
                    ? "Sync Failed"
                    : hasFailed
                      ? "Sync Failed"
                      : isCompleted
                        ? "Sync Complete"
                        : "File Sync"}
              </span>
              <InfoTooltip className="ml-2">
                {isRetrying
                  ? `Sync failed. Retrying ${retryCountdown > 0 ? `in ${retryCountdown}s` : "now"}...`
                  : hasFailed
                    ? "Some files failed to sync. Please try again."
                    : isCompleted
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
            {/* Status text — hidden when expanded since the title already shows status */}
            {!isExpanded && (
              <span className={cn("text-sm mr-2", hasFailed ? "text-error-50" : "text-grey-40")}>
                {isUnhealthy
                  ? "Disconnected"
                  : isRetrying
                    ? retryCountdown > 0 ? `Retry ${retryCountdown}s` : "Retrying..."
                    : hasFailed
                      ? "Failed"
                      : isCompleted
                        ? "Complete"
                        : percentage !== null && percentage < 100
                          ? `${isEncryptingPhase ? "Encrypting" : "Syncing"} ${percentage}%`
                          : isEncryptingPhase
                          ? "Encrypting..."
                          : "Syncing..."
                }
              </span>
            )}

            <div className="transition-transform duration-300 ease-in-out">
              {isExpanded ? (
                <ChevronDown className="h-5 w-5 text-grey-40" />
              ) : (
                <ChevronUp className="h-5 w-5 text-grey-40" />
              )}
            </div>

            {/* Divider to separate actions */}

            {/* Close button - shown when completed or failed and expanded */}
            {(isCompleted || hasFailed) && isExpanded && onClose && (
              <>
                <span className="mx-2 h-5 w-px bg-grey-80" role="separator" />
                <button
                  type="button"
                  aria-label="Close sync status"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    (e.nativeEvent as unknown as { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.();

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
        <div className="bg-grey-100 border border-grey-80 rounded-b-[8px] w-[378px] flex flex-col" style={{ maxHeight: `${BODY_MAX_HEIGHT}px` }}>
          {/* Status banner */}
          <div className="flex flex-col w-full mt-4 ml-4 gap-2">
            <div
              className={cn(
                "w-fit px-2 py-0.5 border rounded",
                isRetrying || snapshot.failedFiles > 0
                  ? "bg-error-100/40 border-error-80"
                  : isCompleted
                    ? "bg-success-100/40 border-success-80"
                    : "bg-primary-100/40 border-primary-80"
              )}
            >
              <div
                className={cn(
                  "text-sm",
                  isRetrying || snapshot.failedFiles > 0
                    ? "text-error-40"
                    : isCompleted
                      ? "text-success-40"
                      : "text-primary-40"
                )}
              >
                {(() => {
                  // Retry state — show countdown
                  if (isRetrying) {
                    return retryCountdown > 0
                      ? `Sync failed \u2014 retrying in ${retryCountdown}s`
                      : "Retrying sync...";
                  }

                  // Total completed = synced (uploaded) + deleted
                  const completedFiles = syncedFiles + deletedFiles;
                  // Calculate actual total including failed files
                  const actualTotal = snapshot.failedFiles > 0
                    ? Math.max(totalFiles, completedFiles + snapshot.failedFiles)
                    : totalFiles;

                  // Determine what type of sync is happening based on action counts
                  const hasUploads = actionCounts?.uploads && actionCounts.uploads > 0;
                  const hasDownloads = actionCounts?.downloads && actionCounts.downloads > 0;
                  const hasLocalDeletes = actionCounts?.localDeletes && actionCounts.localDeletes > 0;
                  const hasRemoteDeletes = actionCounts?.remoteDeletes && actionCounts.remoteDeletes > 0;

                  // If there are failed files, show appropriate failure message
                  if (snapshot.failedFiles > 0 && !isInProgress) {
                    if (hasDownloads && !hasUploads) {
                      return `${snapshot.failedFiles} of ${actualTotal} files failed to download`;
                    }
                    if (hasUploads && !hasDownloads) {
                      return `${snapshot.failedFiles} of ${actualTotal} files failed to upload`;
                    }
                    return `${snapshot.failedFiles} of ${actualTotal} files failed to sync`;
                  }
                  
                  // When completed successfully
                  if (isCompleted) {
                    // Only deletes, no uploads/downloads
                    if (deletedFiles > 0 && syncedFiles === 0) {
                      return `${deletedFiles} ${deletedFiles === 1 ? "file" : "files"} deleted`;
                    }
                    // Mixed: synced + deleted
                    if (deletedFiles > 0 && syncedFiles > 0) {
                      return `${syncedFiles} synced, ${deletedFiles} deleted`;
                    }
                    if (actualTotal > 0) {
                      if (hasDownloads && !hasUploads) {
                        return `${syncedFiles} of ${actualTotal} files downloaded`;
                      }
                      return `${syncedFiles} of ${actualTotal} files synced`;
                    } else if (syncedFiles > 0) {
                      return `${syncedFiles} files synced`;
                    }
                    return "Sync complete";
                  }
                  
                  // During sync, show appropriate message based on action type
                  if (isInProgress || actualTotal > 0) {
                    // Only downloads (no uploads) - show download message
                    if (hasDownloads && !hasUploads) {
                      return `${completedFiles} of ${actualTotal} files downloaded`;
                    }
                    // Only uploads (no downloads) - show upload/sync message
                    if (hasUploads && !hasDownloads) {
                      return `${completedFiles} of ${actualTotal} files synced`;
                    }
                    // Both uploads and downloads - show generic sync message
                    if (hasUploads && hasDownloads) {
                      return `${completedFiles} of ${actualTotal} files synced`;
                    }
                    // Only deletes - show delete message
                    if ((hasLocalDeletes || hasRemoteDeletes) && !hasUploads && !hasDownloads) {
                      const deleteCount = (actionCounts?.localDeletes || 0) + (actionCounts?.remoteDeletes || 0);
                      return `Deleting ${deleteCount} files`;
                    }
                    // Fallback to generic sync message
                    return `${completedFiles} of ${actualTotal} files synced`;
                  }
                  
                  if (completedFiles > 0) {
                    return `${completedFiles} files synced`;
                  }
                  return "Starting sync...";
                })()}
              </div>
            </div>

            {/* Error detail — shown when retrying or when lastError is present */}
            {snapshot.lastError && (isRetrying || hasFailed) && (
              <p className="text-xs text-error-50 mt-1 mr-4 line-clamp-2 break-words">
                {snapshot.lastError}
              </p>
            )}
          </div>

          {/* Overall sync progress bar */}
          {!isCompleted && isInProgress && (
            <div className="px-4 pt-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-grey-40">Overall progress</span>
                <span className="text-xs text-grey-40">
                  {percentage !== null ? `${percentage}%` : "Preparing..."}
                </span>
              </div>
              <div className="w-full h-1.5 bg-grey-80 rounded-full overflow-hidden">
                {percentage !== null ? (
                  <div
                    className={cn("h-full rounded-full transition-all duration-300", isEncryptingPhase ? "bg-warning-50" : "bg-primary-50")}
                    style={{ width: `${percentage}%` }}
                  />
                ) : (
                  <div className={cn("h-full w-1/3 rounded-full animate-pulse", isEncryptingPhase ? "bg-warning-50" : "bg-primary-50")} />
                )}
              </div>
              {snapshot.bytesExpected > 0 && (
                <div className="text-[10px] text-grey-50 mt-1">
                  {formatBytes(snapshot.progressBytes)} / {formatBytes(snapshot.bytesExpected)}
                </div>
              )}
            </div>
          )}

          {/* File list — flex-1 + min-h-0 lets it fill remaining space and scroll */}
          <div 
            ref={fileListRef} 
            className="overflow-y-auto p-4 flex-1 min-h-0"
          >
            {snapshot.files.map((file, index) => {
              const isFileCompleted = file.status === "completed";
              const isFileDeleted = isFileCompleted && (file.action === "local_delete" || file.action === "remote_delete");
              const isFileInProgress = file.status === "inProgress";
              const isEncrypting = file.status === "encrypting";
              const isDecrypting = file.status === "decrypting";
              const isFailed = file.status === "error";
              const { fileFormat } = getFilePartsFromFileName(file.fileName);
              const fileType = getFileTypeFromExtension(fileFormat || null);
              const { icon: Icon, color } = getFileIcon(fileType ? fileType : undefined, false);
              return (
                <div
                  key={`${file.path}-${index}`}
                  className="mb-4 last:mb-0 transition-opacity duration-200"
                  data-file-item
                  data-testid="file-item"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <AbstractIconWrapper className="size-8 flex-shrink-0 flex items-center justify-center">
                        <Icon className={cn("size-5 relative", color)} />
                      </AbstractIconWrapper>
                      <div className="flex flex-col justify-center min-w-0">
                        <div className="flex items-center gap-1 justify-center">
                          <div className="text-sm font-medium text-grey-10 truncate flex items-center gap-2">
                            <span>
                              {file.fileName.length > 25
                                ? `${file.fileName.slice(0, 18)}...${file.fileName.slice(-5)}`
                                : file.fileName}
                            </span>
                          </div>
                        </div>
                        {file.totalBytes > 0 && (
                          <div className="text-xs text-grey-70 mt-1">
                            {formatBytes(file.totalBytes)}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center flex-shrink-0">
                      {isFileDeleted ? (
                        <>
                          <Icons.TickCircle className="w-5 h-5 text-error-50" />
                          <span className="text-sm ml-1 text-error-50">Deleted</span>
                        </>
                      ) : isFileCompleted ? (
                        <>
                          <Icons.TickCircle className="w-5 h-5 text-success-50" />
                          <span className="text-sm ml-1 text-success-50">Synced</span>
                        </>
                      ) : isFailed ? (
                        <>
                          <Icons.InfoCircle className="w-5 h-5 text-error-50" />
                          <span className="text-sm ml-1 text-error-50">Failed</span>
                        </>
                      ) : (isEncrypting || isDecrypting) ? (
                        <div className="flex flex-col items-end gap-0.5">
                          <div className="flex items-center gap-2">
                            <div className="w-[60px] h-1.5 bg-grey-80 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-warning-50 rounded-full transition-all duration-300"
                                style={{ width: `${file.progressPercent}%` }}
                              />
                            </div>
                            <span className="text-xs text-warning-50 min-w-[32px] text-right">
                              {isEncrypting ? "Encrypting" : "Decrypting"}
                            </span>
                          </div>
                          {file.totalBytes > 0 && (
                            <span className="text-[10px] text-grey-50">
                              {formatBytes(file.bytesEncrypted)} / {formatBytes(file.totalBytes)}
                            </span>
                          )}
                        </div>
                      ) : isFileInProgress ? (
                        <div className="flex flex-col items-end gap-0.5">
                          <div className="flex items-center gap-2">
                            <div className="w-[60px] h-1.5 bg-grey-80 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-primary-50 rounded-full transition-all duration-300"
                                style={{ width: `${file.progressPercent}%` }}
                              />
                            </div>
                            <span className="text-xs text-primary-50 min-w-[32px] text-right">
                              {file.progressPercent}%
                            </span>
                          </div>
                          {file.totalBytes > 0 && (
                            <span className="text-[10px] text-grey-50">
                              {formatBytes(file.bytesTransferred)} / {formatBytes(file.totalBytes)}
                            </span>
                          )}
                        </div>
                      ) : file.status === "pending" ? (
                        <>
                          <Icons.InfoCircle className="w-5 h-5 text-warning-50" />
                          <span className="text-sm ml-1 text-warning-50">Pending</span>
                        </>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="w-[60px] h-1.5 bg-grey-80 rounded-full overflow-hidden">
                            <div className="h-full bg-grey-60 rounded-full" style={{ width: "0%" }} />
                          </div>
                          <span className="text-xs text-grey-50 min-w-[32px] text-right">0%</span>
                        </div>
                      )}
                    </div>
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
