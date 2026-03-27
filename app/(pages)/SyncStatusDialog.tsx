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
import MiddleTruncatedName from "@/components/ui/MiddleTruncatedName";

// Use rem so the widget scales with the fluid root font-size
// (clamp(13px, 1.1vw, 16px) set in globals.css).
const COLLAPSED_HEIGHT_REM = 4;      // 64px at 16px base
const EXPANDED_HEIGHT_REM = 28.75;   // 460px at 16px base
const BODY_MAX_HEIGHT_REM = EXPANDED_HEIGHT_REM - COLLAPSED_HEIGHT_REM;

// Collapsed widths (rem) — vary by state so the pill fits its content
const W_COLLAPSED_DONE = "13.75rem";   // 210px — "Complete" / "Failed"
const W_COLLAPSED_WIDE = "15rem";       // 240px — "Syncing 98%"
const W_COLLAPSED_NARROW = "14rem";  // 220px — "Syncing..." / single-digit %
const W_EXPANDED = "23.625rem";         // 378px

/** Format seconds into a human-readable ETA string. */
function formatEta(totalSeconds: number): string {
  if (totalSeconds < 5) return "a few seconds";
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

/** ETA sample for rate calculation */
interface RateSample {
  time: number;   // Date.now()
  bytes: number;  // progressBytes at that time
}

/** Number of samples to keep for moving average */
const RATE_WINDOW = 10;

interface SyncStatusDialogProps {
  snapshot: SyncSnapshot;
  open: boolean;
  onClose?: () => void;
  /** When true the sync loop has started but no session exists yet. */
  isPreparing?: boolean;
}

const SyncStatusDialog: React.FC<SyncStatusDialogProps> = ({
  snapshot,
  open,
  onClose,
  isPreparing = false,
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
  const totalFiles = snapshot.totalFiles;
  const isSingleFile = totalFiles === 1;

  // ── Smoothed progress ──────────────────────────────────────────
  // Interpolate between snapshot.overallPercent values so the bar
  // doesn't jump when a file finishes. CSS transition handles the
  // visual smoothing; this ensures percentage never goes backwards.
  const rawPercent = isInProgress && snapshot.totalFiles > 0 && snapshot.overallPercent === 0 && snapshot.bytesExpected === 0
    ? null
    : snapshot.overallPercent;
  const [smoothedPercent, setSmoothedPercent] = useState<number | null>(rawPercent);
  const prevSessionRef = useRef<number | null>(null);

  useEffect(() => {
    // Reset smoothed progress when a new session starts
    if (snapshot.startedAt !== prevSessionRef.current) {
      prevSessionRef.current = snapshot.startedAt;
      setSmoothedPercent(rawPercent);
      return;
    }
    if (rawPercent === null) {
      setSmoothedPercent(null);
      return;
    }
    // Only move forward (never decrease), unless completed
    setSmoothedPercent((prev) => {
      if (prev === null) return rawPercent;
      if (rawPercent >= 100) return 100;
      return Math.max(prev, rawPercent);
    });
  }, [rawPercent, snapshot.startedAt]);

  const percentage = smoothedPercent;

  // ── ETA Calculation ────────────────────────────────────────────
  // Track byte rate over recent samples to estimate remaining time.
  const rateSamplesRef = useRef<RateSample[]>([]);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [speedBytesPerSec, setSpeedBytesPerSec] = useState<number | null>(null);

  useEffect(() => {
    if (!isInProgress || snapshot.bytesExpected === 0 || snapshot.progressBytes === 0) {
      // Reset when not actively transferring
      if (!isInProgress) {
        rateSamplesRef.current = [];
        setEtaSeconds(null);
        setSpeedBytesPerSec(null);
      }
      return;
    }

    const now = Date.now();
    const samples = rateSamplesRef.current;
    const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;

    // Only add a new sample if bytes actually changed
    if (!lastSample || snapshot.progressBytes !== lastSample.bytes) {
      samples.push({ time: now, bytes: snapshot.progressBytes });
      // Keep only the last RATE_WINDOW samples
      if (samples.length > RATE_WINDOW) {
        samples.splice(0, samples.length - RATE_WINDOW);
      }
    }

    // Need at least 2 samples to compute a rate
    if (samples.length < 2) {
      setEtaSeconds(null);
      return;
    }

    const oldest = samples[0];
    const newest = samples[samples.length - 1];
    const elapsed = (newest.time - oldest.time) / 1000; // seconds
    const bytesTransferred = newest.bytes - oldest.bytes;

    if (elapsed <= 0 || bytesTransferred <= 0) {
      return; // keep previous ETA, don't clear it
    }

    const rate = bytesTransferred / elapsed; // bytes per second
    setSpeedBytesPerSec(rate);
    const remaining = snapshot.bytesExpected - snapshot.progressBytes;
    const eta = remaining / rate;

    // Clamp ETA to reasonable bounds (max 24h)
    setEtaSeconds(Math.min(eta, 86400));
  }, [isInProgress, snapshot.progressBytes, snapshot.bytesExpected]);

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

  if (!open) return null;
  // Nothing to show — no files, not active, not retrying, not completed, not preparing
  if (snapshot.totalFiles === 0 && !isInProgress && !isRetrying && !isCompleted && !isPreparing) return null;

  // Derive counts for the status banner
  const syncedFiles = snapshot.completedFiles;
  const deletedFiles = snapshot.files.filter(
    (f) => (f.action === "local_delete" || f.action === "remote_delete") && f.status === "completed"
  ).length;

  return (
    <div
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      className="outline-none shadow-menu rounded-[8px] transition-all duration-300 ease-in-out"
      style={{ width: isExpanded ? W_EXPANDED : isCompleted || hasFailed ? W_COLLAPSED_DONE : percentage !== null && percentage >= 10 ? W_COLLAPSED_WIDE : W_COLLAPSED_NARROW }}
    >
      {/* Header */}
      <div
        className={cn(
          "shadow-menu bg-grey-100 border border-grey-80 cursor-pointer hover:bg-grey-90 transition-all duration-300 ease-in-out",
          isExpanded
            ? "rounded-t-[8px]"
            : "rounded-[8px]"
        )}
        style={{ width: isExpanded ? W_EXPANDED : isCompleted || hasFailed ? W_COLLAPSED_DONE : percentage !== null && percentage >= 10 ? W_COLLAPSED_WIDE : W_COLLAPSED_NARROW }}
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
                  className="fill-none stroke-[4] stroke-[#e8eeff]"
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
                      <Icons.Refresh className="size-6 relative animate-spin text-primary-50" />
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
                          ? `Syncing ${percentage}%`
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

            {/* Close button - always available */}
            {onClose && (
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
          maxHeight: isExpanded ? `${BODY_MAX_HEIGHT_REM}rem` : "0px",
          opacity: isExpanded ? 1 : 0,
        }}
      >
        <div className="bg-grey-100 border border-grey-80 rounded-b-[8px] flex flex-col" style={{ width: W_EXPANDED, maxHeight: `${BODY_MAX_HEIGHT_REM}rem` }}>
          {/* Status banner */}
          <div className="flex flex-col w-full mt-4 ml-4 gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              {(() => {
                // Retry state — show countdown
                if (isRetrying) {
                  return (
                    <div className={cn("w-fit px-2 py-0.5 border rounded", "bg-error-100/40 border-error-80")}>
                      <div className="text-sm text-error-40">
                        {retryCountdown > 0
                          ? `Sync failed \u2014 retrying in ${retryCountdown}s`
                          : "Retrying sync..."}
                      </div>
                    </div>
                  );
                }

                // Total completed = synced (uploaded) + deleted
                const completedFiles = syncedFiles + deletedFiles;
                // Calculate actual total including failed files
                const actualTotal = snapshot.failedFiles > 0
                  ? Math.max(totalFiles, completedFiles + snapshot.failedFiles)
                  : totalFiles;

                // Determine what type of sync is happening based on snapshot action counts
                const hasUploads = snapshot.expectedUploads > 0;
                const hasDownloads = snapshot.expectedDownloads > 0;
                const hasLocalDeletes = snapshot.expectedLocalDeletes > 0;
                const hasRemoteDeletes = snapshot.expectedRemoteDeletes > 0;
                const nonDeleteSynced = syncedFiles - deletedFiles;

                // If there are failed files, show appropriate failure message
                if (snapshot.failedFiles > 0 && !isInProgress) {
                  let failMsg: string;
                  if (hasDownloads && !hasUploads) {
                    failMsg = `${snapshot.failedFiles} of ${actualTotal} files failed to download`;
                  } else if (hasUploads && !hasDownloads) {
                    failMsg = `${snapshot.failedFiles} of ${actualTotal} files failed to upload`;
                  } else {
                    failMsg = `${snapshot.failedFiles} of ${actualTotal} files failed to sync`;
                  }
                  return (
                    <div className="w-fit px-2 py-0.5 border rounded bg-error-100/40 border-error-80">
                      <div className="text-sm text-error-40">{failMsg}</div>
                    </div>
                  );
                }
                
                // When completed successfully
                if (isCompleted) {
                  const badges: React.ReactNode[] = [];

                  // Combined badge: when both synced and deleted, show total as "synced";
                  // when only deletions, show "deleted"
                  if (nonDeleteSynced > 0 && deletedFiles > 0) {
                    // Mixed: combine into a single "synced" badge
                    const total = nonDeleteSynced + deletedFiles;
                    let syncText: string;
                    if (hasDownloads && !hasUploads) {
                      syncText = `${total} ${total === 1 ? "file" : "files"} downloaded`;
                    } else {
                      syncText = `${total} ${total === 1 ? "file" : "files"} synced`;
                    }
                    badges.push(
                      <div key="synced" className="w-fit px-2 py-0.5 border rounded bg-success-100/40 border-success-80">
                        <div className="text-sm text-success-40">{syncText}</div>
                      </div>
                    );
                  } else if (nonDeleteSynced > 0) {
                    // Only uploads/downloads, no deletes
                    let syncText: string;
                    if (hasDownloads && !hasUploads) {
                      syncText = `${nonDeleteSynced} ${nonDeleteSynced === 1 ? "file" : "files"} downloaded`;
                    } else {
                      syncText = `${nonDeleteSynced} ${nonDeleteSynced === 1 ? "file" : "files"} synced`;
                    }
                    badges.push(
                      <div key="synced" className="w-fit px-2 py-0.5 border rounded bg-success-100/40 border-success-80">
                        <div className="text-sm text-success-40">{syncText}</div>
                      </div>
                    );
                  } else if (deletedFiles > 0) {
                    // Only deletions
                    badges.push(
                      <div key="deleted" className="w-fit px-2 py-0.5 border rounded bg-success-100/40 border-success-80">
                        <div className="text-sm text-success-40">{`${deletedFiles} ${deletedFiles === 1 ? "file" : "files"} deleted`}</div>
                      </div>
                    );
                  }

                  // Fallback if no synced or deleted
                  if (badges.length === 0) {
                    badges.push(
                      <div key="complete" className="w-fit px-2 py-0.5 border rounded bg-success-100/40 border-success-80">
                        <div className="text-sm text-success-40">Sync complete</div>
                      </div>
                    );
                  }

                  return <>{badges}</>;
                }
                
                // During sync
                let inProgressText: string;
                if (isInProgress || actualTotal > 0) {
                  if (hasDownloads && !hasUploads) {
                    inProgressText = `${completedFiles} of ${actualTotal} files downloaded`;
                  } else if ((hasLocalDeletes || hasRemoteDeletes) && !hasUploads && !hasDownloads) {
                    const deleteCount = snapshot.expectedLocalDeletes + snapshot.expectedRemoteDeletes;
                    inProgressText = `Deleting ${deleteCount} files`;
                  } else {
                    inProgressText = `${completedFiles} of ${actualTotal} files synced`;
                  }
                } else if (completedFiles > 0) {
                  inProgressText = `${completedFiles} files synced`;
                } else {
                  inProgressText = "Preparing sync...";
                }

                return (
                  <div className="w-fit px-2 py-0.5 border rounded bg-primary-100/40 border-primary-80">
                    <div className="text-sm text-primary-40">{inProgressText}</div>
                  </div>
                );
              })()}
            </div>

            {/* Error detail — shown when retrying or when lastError is present */}
            {snapshot.lastError && (isRetrying || hasFailed) && (
              <p className="text-xs text-error-50 mt-1 mr-4 line-clamp-2 break-words">
                {snapshot.lastError}
              </p>
            )}
          </div>

          {/* Overall sync progress bar — shown for multi-file syncs while in progress */}
          {!isSingleFile && isInProgress && !isCompleted && (
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
                    className="h-full rounded-full bg-primary-50 transition-[width] duration-700 ease-out"
                    style={{ width: `${percentage}%` }}
                  />
                ) : (
                  <div className="h-full w-1/3 rounded-full animate-pulse bg-primary-50" />
                )}
              </div>
              <div className="flex items-center justify-between mt-1">
                <div className="flex items-center gap-2">
                  {snapshot.bytesExpected > 0 && (
                    <span className="text-[0.625rem] text-grey-50">
                      {formatBytes(snapshot.progressBytes)} / {formatBytes(snapshot.bytesExpected)}
                    </span>
                  )}
                  {speedBytesPerSec !== null && speedBytesPerSec > 0 && (
                    <span className="text-[0.625rem] text-grey-50">
                      · {formatBytes(Math.round(speedBytesPerSec))}/s
                    </span>
                  )}
                </div>
                {etaSeconds !== null && etaSeconds > 0 && (
                  <span className="text-[0.625rem] text-grey-50">
                    ~{formatEta(etaSeconds)} remaining
                  </span>
                )}
              </div>
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
              const isEncryptingOrDecrypting = file.status === "encrypting" || file.status === "decrypting";
              const isFileInProgress = file.status === "inProgress" || isEncryptingOrDecrypting;
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
                  {/* Row 1: icon + name + status/progress */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <AbstractIconWrapper className="size-8 flex-shrink-0 flex items-center justify-center">
                        <Icon className={cn("size-5 relative", color)} />
                      </AbstractIconWrapper>
                      <MiddleTruncatedName
                        name={file.fileName}
                        className="text-sm font-medium text-grey-10"
                      />
                    </div>

                    <div className="flex items-center flex-shrink-0 ml-2">
                      {isFileDeleted ? (
                        <>
                          <Icons.TickCircle className="w-5 h-5 text-success-50" />
                          <span className="text-sm ml-1 text-success-50">Deleted</span>
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
                      ) : isFileInProgress ? (
                        isEncryptingOrDecrypting ? (
                          <span className="text-xs text-primary-50">
                            {file.status === "encrypting" ? "Encrypting..." : "Decrypting..."}
                          </span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <div className="w-[3.75rem] h-1.5 bg-grey-80 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-primary-50 rounded-full transition-[width] duration-700 ease-out"
                                style={{ width: `${file.progressPercent}%` }}
                              />
                            </div>
                            <span className="text-xs text-primary-50 min-w-[2rem] text-right">
                              {file.progressPercent}%
                            </span>
                          </div>
                        )
                      ) : file.status === "pending" ? (
                        <>
                          <Icons.InfoCircle className="w-5 h-5 text-warning-50" />
                          <span className="text-sm ml-1 text-warning-50">Pending</span>
                        </>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="w-[3.75rem] h-1.5 bg-grey-80 rounded-full overflow-hidden">
                            <div className="h-full bg-grey-60 rounded-full" style={{ width: "0%" }} />
                          </div>
                          <span className="text-xs text-grey-50 min-w-[2rem] text-right">0%</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Row 2: file size + transfer detail */}
                  {file.totalBytes > 0 && (
                    <div className="flex items-center justify-between pl-10">
                      <span className="text-[0.625rem] text-grey-50">
                        {formatBytes(file.totalBytes)}
                      </span>
                      {isFileInProgress && !isEncryptingOrDecrypting && (
                        <span className="text-[0.625rem] text-grey-50">
                          {formatBytes(file.bytesTransferred)} / {formatBytes(file.totalBytes)}
                          {isSingleFile && speedBytesPerSec !== null && speedBytesPerSec > 0
                            ? ` · ${formatBytes(Math.round(speedBytesPerSec))}/s`
                            : ""}
                          {isSingleFile && etaSeconds !== null && etaSeconds > 0
                            ? ` · ~${formatEta(etaSeconds)}`
                            : ""}
                        </span>
                      )}
                    </div>
                  )}
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
