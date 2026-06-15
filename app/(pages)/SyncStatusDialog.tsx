"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { Graphsheet } from "@/components/ui";
import * as Icons from "@/components/ui/icons";
import React, { useState, useEffect, useRef, useCallback, memo } from "react";
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
import { type SyncSnapshot, type FileProgress } from "../lib/types/syncSnapshot";
import MiddleTruncatedName from "@/components/ui/MiddleTruncatedName";

// Use rem so the widget scales with the fluid root font-size
// (clamp(13px, 1.1vw, 16px) set in globals.css).
const COLLAPSED_HEIGHT_REM = 4;      // 64px at 16px base
const EXPANDED_HEIGHT_REM = 28.75;   // 460px at 16px base
const BODY_MAX_HEIGHT_REM = EXPANDED_HEIGHT_REM - COLLAPSED_HEIGHT_REM;

// Collapsed widths (rem) — separate states to avoid width jumps and clipping
const W_COLLAPSED_DONE = "13.75rem";          // 220px — "Complete" / "Failed"
const W_COLLAPSED_ACTIVE = "15.5rem";        // 248px — "Syncing..." / "Syncing 98%"
const W_COLLAPSED_RETRY = "15.5rem";         // 248px — "Retry 30s" / "Retrying..."
const W_COLLAPSED_DISCONNECTED = "16.25rem"; // 260px — "Disconnected"
const W_EXPANDED = "26rem";                  // 416px

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

// ── Memoized file item ─────────────────────────────────────────────
// Extracted so React can skip re-rendering files whose visible fields
// haven't changed. Without this, every 250ms snapshot update re-runs
// getFilePartsFromFileName / getFileTypeFromExtension / getFileIcon
// for every file in the list.

interface SyncFileItemProps {
  file: FileProgress;
  isSingleFile: boolean;
  effectiveInProgress: boolean;
  speedBytesPerSec: number | null;
  etaSeconds: number | null;
}

const SyncFileItem = memo<SyncFileItemProps>(function SyncFileItem({
  file,
  isSingleFile,
  effectiveInProgress,
  speedBytesPerSec,
  etaSeconds,
}) {
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
      className="mb-4 last:mb-0"
      data-file-item
      data-testid="file-item"
    >
      <div className="flex gap-2">
        <AbstractIconWrapper className="size-8 flex-shrink-0 flex items-center justify-center self-center">
          <Icon className={cn("size-5 relative", color)} />
        </AbstractIconWrapper>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <MiddleTruncatedName
              name={file.fileName}
              className="text-sm font-medium text-grey-10"
            />

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
                    <span>{file.status === "encrypting" ? "Encrypting" : "Decrypting"}</span>
                    <span className="inline-flex w-[0.875rem]">
                      <span className="animate-[dotPulse_1.4s_ease-in-out_infinite]">.</span>
                      <span className="animate-[dotPulse_1.4s_0.2s_ease-in-out_infinite]">.</span>
                      <span className="animate-[dotPulse_1.4s_0.4s_ease-in-out_infinite]">.</span>
                    </span>
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

          {file.totalBytes > 0 && (
            isFileInProgress && !isEncryptingOrDecrypting ? (
              <div className="flex items-center justify-between -mt-0.5">
                <span className="text-[0.625rem] text-grey-50">
                  {formatBytes(file.bytesTransferred)} / {formatBytes(file.totalBytes)}
                </span>
                {isSingleFile && effectiveInProgress && speedBytesPerSec !== null && speedBytesPerSec > 0 && (
                  <span className="text-[0.625rem] text-grey-50">
                    {formatBytes(Math.round(speedBytesPerSec))}/s
                    {etaSeconds !== null && etaSeconds > 0
                      ? ` · ~${formatEta(etaSeconds)}`
                      : ""}
                  </span>
                )}
              </div>
            ) : isEncryptingOrDecrypting ? (
              <div className="flex items-center justify-between -mt-0.5">
                <span className="text-[0.625rem] text-grey-50">
                  {formatBytes(file.totalBytes)}
                </span>
                {isSingleFile && effectiveInProgress && etaSeconds !== null && etaSeconds > 0 && (
                  <span className="text-[0.625rem] text-grey-50">
                    ~{formatEta(etaSeconds)} remaining
                  </span>
                )}
              </div>
            ) : (
              <div className="-mt-0.5">
                <span className="text-[0.625rem] text-grey-50">
                  {formatBytes(file.totalBytes)}
                </span>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}, (prev, next) => {
  const pf = prev.file;
  const nf = next.file;
  return (
    pf.status === nf.status &&
    pf.progressPercent === nf.progressPercent &&
    pf.bytesTransferred === nf.bytesTransferred &&
    pf.bytesEncrypted === nf.bytesEncrypted &&
    pf.action === nf.action &&
    pf.fileName === nf.fileName &&
    pf.totalBytes === nf.totalBytes &&
    pf.error === nf.error &&
    prev.isSingleFile === next.isSingleFile &&
    prev.effectiveInProgress === next.effectiveInProgress &&
    prev.speedBytesPerSec === next.speedBytesPerSec &&
    prev.etaSeconds === next.etaSeconds
  );
});

// ── Main dialog ────────────────────────────────────────────────────

interface SyncStatusDialogProps {
  snapshot: SyncSnapshot;
  open: boolean;
  onClose?: () => void;
}

const SyncStatusDialog: React.FC<SyncStatusDialogProps> = ({
  snapshot,
  open,
  onClose,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const engineHealth = useAtomValue(syncEngineHealthAtom);

  const isUnhealthy = engineHealth.status !== "connected";

  // Display state pre-computed by Rust snapshot
  const isInProgress = snapshot.isActive;
  const isRetrying = !snapshot.isActive && snapshot.retryInSecs > 0;
  const isCompleted = !snapshot.isActive && !isRetrying && (snapshot.completedFiles > 0 || snapshot.failedFiles > 0);
  const hasFailed = (snapshot.failedFiles > 0 && isCompleted) || isRetrying;
  const totalFiles = snapshot.totalFiles;
  const isSingleFile = totalFiles === 1;
  const effectiveInProgress = snapshot.effectiveInProgress;
  const effectiveCompleted = snapshot.effectiveCompleted;
  // Rust marks `widgetState="preparing"` between SyncStarted and the
  // first session-populated snapshot for file-watcher-initiated
  // cycles. The title, tooltip, collapsed-header status and badge all
  // branch on this flag — without it the three surfaces would
  // disagree (collapsed: "Syncing 0%", title: "File Sync", badge:
  // "Preparing sync...") because each has its own derived condition.
  const isPreparing = snapshot.widgetState === "preparing";

  // ── Smoothed progress ──────────────────────────────────────────
  // Interpolate between snapshot.overallPercent values so the bar
  // doesn't jump when a file finishes. CSS transition handles the
  // visual smoothing; this ensures percentage never goes backwards.
  const rawPercent = isInProgress && snapshot.totalFiles > 0 && snapshot.overallPercent === 0 && snapshot.bytesExpected === 0
    ? null
    : snapshot.overallPercent;
  const [smoothedPercent, setSmoothedPercent] = useState<number | null>(rawPercent);
  const prevSessionRef = useRef<number | null>(null);
  const prevTotalFilesRef = useRef<number>(snapshot.totalFiles);

  useEffect(() => {
    // Reset smoothed progress when a new session starts
    if (snapshot.startedAt !== prevSessionRef.current) {
      prevSessionRef.current = snapshot.startedAt;
      prevTotalFilesRef.current = snapshot.totalFiles;
      setSmoothedPercent(rawPercent);
      return;
    }
    // When new files are added mid-session (deferred completion),
    // allow the percentage to adjust downward to reflect the extra work.
    if (snapshot.totalFiles > prevTotalFilesRef.current) {
      prevTotalFilesRef.current = snapshot.totalFiles;
      setSmoothedPercent(rawPercent);
      return;
    }
    prevTotalFilesRef.current = snapshot.totalFiles;
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
  }, [rawPercent, snapshot.startedAt, snapshot.totalFiles]);

  const percentage = smoothedPercent;

  // ── ETA Calculation ────────────────────────────────────────────
  // Track byte rate over recent samples to estimate remaining time.
  // Uses combined encrypt + transfer bytes so ETA shows during both
  // encryption and upload/download phases.
  const rateSamplesRef = useRef<RateSample[]>([]);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [speedBytesPerSec, setSpeedBytesPerSec] = useState<number | null>(null);

  // Combined progress pre-computed by Rust
  const combinedProgressBytes = snapshot.combinedProgressBytes;
  const combinedBytesExpected = snapshot.combinedBytesExpected;

  useEffect(() => {
    if (!effectiveInProgress || combinedBytesExpected === 0 || combinedProgressBytes === 0) {
      // Reset when not actively transferring
      if (!effectiveInProgress) {
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
    if (!lastSample || combinedProgressBytes !== lastSample.bytes) {
      samples.push({ time: now, bytes: combinedProgressBytes });
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
    const bytesProcessed = newest.bytes - oldest.bytes;

    if (elapsed <= 0 || bytesProcessed <= 0) {
      return; // keep previous ETA, don't clear it
    }

    const rate = bytesProcessed / elapsed; // bytes per second
    setSpeedBytesPerSec(rate);
    const remaining = combinedBytesExpected - combinedProgressBytes;
    const eta = remaining / rate;

    // Clamp ETA to reasonable bounds (max 24h)
    setEtaSeconds(Math.min(eta, 86400));
  }, [effectiveInProgress, combinedProgressBytes, combinedBytesExpected]);

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

  // NOTE: a previous scroll-fade implementation lived here. It iterated
  // `[data-file-item]` rows on every scroll event and set inline
  // `el.style.opacity` based on each row's position. It had three bugs:
  //
  //   1. The bottom-edge formula `(clientHeight - offsetTop) / bottomFade`
  //      could produce values WAY larger than 1 (e.g. opacity: 2.8) for
  //      rows nowhere near the bottom edge.
  //   2. The handler only ran on `scroll` events, but the inline opacity
  //      it set was persistent. When React re-rendered the file list,
  //      the stale inline opacities stuck to whichever DOM nodes React
  //      reused — assigning random opacities to rows that were no longer
  //      near the fade band.
  //   3. The opacity transition combined with text-content updates caused
  //      the GPU compositor to re-rasterize each row's text on every
  //      frame, producing a visible "doubled text" artifact on macOS
  //      WebKit during mid-animation.
  //
  // Replaced with a CSS mask gradient on the scroll container (see the
  // file-list `<div>` below). Pure CSS, no JS, no inline styles.

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
  // Nothing to show — no files, not active, not retrying, not completed
  if (snapshot.totalFiles === 0 && !isInProgress && !isRetrying && !isCompleted) return null;


  return (
    <div
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      className="outline-none shadow-menu rounded-[0.5rem] overflow-hidden transition-[width] duration-300 ease-in-out"
      style={{ width: isExpanded
        ? W_EXPANDED
        : isUnhealthy
          ? W_COLLAPSED_DISCONNECTED
          : isRetrying
            ? W_COLLAPSED_RETRY
            : effectiveCompleted || isCompleted || hasFailed
              ? W_COLLAPSED_DONE
              : W_COLLAPSED_ACTIVE
      }}
    >
      {/* Header */}
      <div
        className={cn(
          "shadow-menu bg-grey-100 border border-grey-80 cursor-pointer hover:bg-grey-90 transition-[border-radius] duration-300 ease-in-out",
          isExpanded
            ? "rounded-t-[0.5rem]"
            : "rounded-[0.5rem]"
        )}
        onClick={handleHeaderClick}
      >
        <div
          className={cn(
            "relative flex items-center gap-3 justify-between transition-[padding] duration-300 ease-in-out",
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
                "relative transition-[opacity,width] duration-300",
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
                      : effectiveCompleted || isCompleted
                        ? "stroke-[#4ade80]"
                        : "stroke-[#4171e0]"
                  )}
                  strokeLinecap="round"
                  strokeDasharray={isUnhealthy || hasFailed ? "138 138" : (effectiveCompleted || isCompleted) ? "138 138" : percentage !== null ? `${percentage * 1.38} 138` : "17 138"}
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
                    {effectiveCompleted || isCompleted ? (
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
                "flex items-center transition-[opacity,transform] duration-300",
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
                      : effectiveCompleted
                        ? "Sync Complete"
                        : isPreparing
                          ? "Preparing Sync"
                          : "File Sync"}
              </span>
              <InfoTooltip className="ml-2">
                {isRetrying
                  ? `Sync failed. Retrying ${retryCountdown > 0 ? `in ${retryCountdown}s` : "now"}...`
                  : hasFailed
                    ? "Some files failed to sync. Please try again."
                    : effectiveCompleted
                      ? "All files have been successfully synced to the network."
                      : isPreparing
                        ? "Scanning your sync folder for changes. The transfer will start shortly."
                        : "Your files are being synced to the Hippius network. This process may take a few minutes."}
              </InfoTooltip>
            </h2>
          </div>

          <div
            className={cn(
              "flex items-center whitespace-nowrap transition-[opacity] duration-300 ease-in-out",
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
                      : effectiveCompleted || isCompleted
                        ? "Complete"
                        : isPreparing
                          ? "Preparing..."
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
          maxHeight: isExpanded ? `${BODY_MAX_HEIGHT_REM}rem` : "0",
          opacity: isExpanded ? 1 : 0,
        }}
      >
        <div className="bg-grey-100 border border-grey-80 rounded-b-[0.5rem] flex flex-col" style={{ width: W_EXPANDED, maxHeight: `${BODY_MAX_HEIGHT_REM}rem` }}>
          {/* Status banner */}
          <div className="flex flex-col w-full mt-4 ml-4 gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              {(() => {
                // Retry state — show countdown (only part that needs live React state)
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

                // Status text and variant pre-computed by Rust
                const variantClasses: Record<string, string> = {
                  error: "bg-error-100/40 border-error-80 text-error-40",
                  success: "bg-success-100/40 border-success-80 text-success-40",
                  progress: "bg-primary-100/40 border-primary-80 text-primary-40",
                };
                // Format badge text from structured data
                const { syncedCount, deletedCount, actualTotal, failedFiles, syncDirection, effectiveCompleted, effectiveInProgress } = snapshot;
                const completedTotal = syncedCount + deletedCount;
                let badgeText: string;
                // Short-circuit on the preparing flag computed above. The
                // trailing else of this chain ALSO writes "Preparing sync..."
                // (a generic empty-state fallback) — both code paths
                // converge on the same copy so the badge stays consistent
                // with the title/tooltip/collapsed-status branches that
                // gate on `isPreparing` only.
                if (isPreparing) {
                  badgeText = "Preparing sync...";
                } else if (snapshot.statusVariant === "error") {
                  const verb = syncDirection === "download" ? "download" : syncDirection === "upload" ? "upload" : "sync";
                  badgeText = `${failedFiles} of ${actualTotal} files failed to ${verb}`;
                } else if (effectiveCompleted) {
                  if (syncedCount > 0 && deletedCount > 0) {
                    badgeText = syncDirection === "download"
                      ? `${completedTotal} ${completedTotal === 1 ? "file" : "files"} downloaded`
                      : `${completedTotal} ${completedTotal === 1 ? "file" : "files"} synced`;
                  } else if (syncedCount > 0) {
                    badgeText = syncDirection === "download"
                      ? `${syncedCount} ${syncedCount === 1 ? "file" : "files"} downloaded`
                      : `${syncedCount} ${syncedCount === 1 ? "file" : "files"} synced`;
                  } else if (deletedCount > 0) {
                    badgeText = `${deletedCount} ${deletedCount === 1 ? "file" : "files"} deleted`;
                  } else {
                    badgeText = "Sync complete";
                  }
                } else if (effectiveInProgress || actualTotal > 0) {
                  if (syncDirection === "download") {
                    badgeText = `${completedTotal} of ${actualTotal} files downloaded`;
                  } else if (syncDirection === "delete") {
                    badgeText = `Deleting ${actualTotal} ${actualTotal === 1 ? "file" : "files"}`;
                  } else {
                    badgeText = `${completedTotal} of ${actualTotal} files synced`;
                  }
                } else {
                  badgeText = "Preparing sync...";
                }

                const classes = variantClasses[snapshot.statusVariant] || variantClasses.progress;
                return (
                  <div className={cn("w-fit px-2 py-0.5 border rounded", classes)}>
                    <div className="text-sm">{badgeText}</div>
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
          {!isSingleFile && effectiveInProgress && !effectiveCompleted && (
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
                  {/* When the intent manifest is active, show user-truthful
                      "X of Y" totals (what the user dragged in, vs. what
                      has finished). Use `??` (not `||`) so an explicit
                      `intentTotalBytes: 0` is not misread as "fall back" —
                      0-totals correctly fail the `> 0` guard. Fall back to
                      the per-cycle line on legacy / pre-login snapshots
                      where intent fields are `undefined`. */}
                  {(snapshot.intentActive ?? false) && (snapshot.intentTotalBytes ?? 0) > 0 ? (
                    <span className="text-[0.625rem] text-grey-50">
                      {formatBytes(snapshot.intentCompletedBytes ?? 0)} of {formatBytes(snapshot.intentTotalBytes ?? 0)}
                    </span>
                  ) : snapshot.bytesExpected > 0 ? (
                    <span className="text-[0.625rem] text-grey-50">
                      {formatBytes(snapshot.progressBytes)} / {formatBytes(snapshot.bytesExpected)}
                    </span>
                  ) : null}
                  {effectiveInProgress && speedBytesPerSec !== null && speedBytesPerSec > 0 && (
                    <span className="text-[0.625rem] text-grey-50">
                      · {formatBytes(Math.round(speedBytesPerSec))}/s
                    </span>
                  )}
                </div>
                {effectiveInProgress && etaSeconds !== null && etaSeconds > 0 && (
                  <span className="text-[0.625rem] text-grey-50">
                    ~{formatEta(etaSeconds)} remaining
                  </span>
                )}
              </div>
            </div>
          )}

          {/* File list — flex-1 + min-h-0 lets it fill remaining space and
              scroll. The mask-image gradient fades content at the top and
              bottom edges purely in CSS — replaces the buggy JS scroll
              handler that previously set inline opacity per row and caused
              the doubled-text rendering artifact. */}
          <div
            className="overflow-y-auto p-4 flex-1 min-h-0"
            style={{
              maskImage:
                "linear-gradient(to bottom, transparent 0, black 1.25rem, black calc(100% - 1.25rem), transparent 100%)",
              WebkitMaskImage:
                "linear-gradient(to bottom, transparent 0, black 1.25rem, black calc(100% - 1.25rem), transparent 100%)",
            }}
          >
            {/* Only build the per-file rows when the body is actually visible.
                The collapsed body is CSS-hidden (max-height:0) but the dialog
                re-renders up to ~4x/sec during a sync; mapping the whole file
                list each time was wasted reconciliation. The wrapper stays
                mounted so the open/close transition still animates, and the
                list renders synchronously on first expand (no empty flash). */}
            {isExpanded &&
              snapshot.files.map((file) => (
                <SyncFileItem
                  key={file.path}
                  file={file}
                  isSingleFile={isSingleFile}
                  effectiveInProgress={effectiveInProgress}
                  speedBytesPerSec={speedBytesPerSec}
                  etaSeconds={etaSeconds}
                />
              ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SyncStatusDialog;
