"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";

import * as Icons from "@/components/ui/icons";
import MiddleTruncatedName from "@/components/ui/MiddleTruncatedName";
import {
  cn,
  getFilePartsFromFileName,
  getFileTypeFromExtension,
} from "@/lib/utils";
import { formatBytes } from "@/lib/utils/formatBytes";

import {
  syncEngineHealthAtom,
  CONNECTIVITY_STATUS_LABELS,
} from "../lib/store/syncAtoms";
import {
  type FileProgress,
  type SyncSnapshot,
} from "../lib/types/syncSnapshot";
import { getFileIcon } from "../lib/utils/fileTypeUtils";
import SyncQueueOverallProgress from "./SyncQueueOverallProgress";
import SyncStatusMini from "./SyncStatusMini";
import {
  resolveSmoothedPercent,
  selectLiveTransferBytes,
  smoothSpeed,
} from "./syncStatusDialogLogic";

const BODY_MAX_HEIGHT_REM = 11.5;
const RATE_WINDOW = 10;

type StatusTone = "progress" | "success" | "error";

interface RateSample {
  time: number;
  bytes: number;
}

interface SyncStatusDialogProps {
  snapshot: SyncSnapshot;
  open: boolean;
  onClose?: () => void;
  /**
   * Render the compact circular form ({@link SyncStatusMini}) instead of the
   * full card. Set when the sidebar is collapsed or the user minimized the
   * widget via the ✕ icon. See {@link syncWidgetMinimizedAtom}.
   */
  minimized?: boolean;
  /** Invoked when the minimized ring is clicked — expands back to full. */
  onExpand?: () => void;
  /**
   * Corner the collapse/expand grow animation anchors to: `bottom-left` for
   * the sidebar footer, `bottom-right` for the portal overlay (the default,
   * matching the old bottom-right widget).
   */
  expandOrigin?: "bottom-left" | "bottom-right";
}

interface SyncFileItemProps {
  file: FileProgress;
}

type SyncFileStatusBadgeVariant =
  | "progress"
  | "pending"
  | "success"
  | "error"
  | "active"
  | "neutral";

interface SyncFileStatusDotProps {
  outerColor: string;
  innerColor: string;
  outerOpacity?: number;
}

interface SyncFileStatusBadgeProps {
  variant: SyncFileStatusBadgeVariant;
  label: string;
  percentage?: number;
}

function formatEta(totalSeconds: number): string {
  if (totalSeconds < 5) return "a few seconds";
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (minutes < 60)
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatCompactBytes(value: number): string {
  return formatBytes(value).replace(/\s+/g, "");
}

function getStatusTone(options: {
  isUnhealthy: boolean;
  hasFailed: boolean;
  isComplete: boolean;
}): StatusTone {
  if (options.isUnhealthy || options.hasFailed) return "error";
  // A successfully-finished sync gets the green "success" tone (collapsed ring
  // check + tooltip). Without this branch tone could only be "error"/"progress",
  // so a completed sync rendered as a blue in-progress ring and the success
  // palette in SyncStatusMini/the tooltip was unreachable.
  if (options.isComplete) return "success";
  return "progress";
}

function getFileProcessedBytes(file: FileProgress): number {
  if (file.status === "completed") {
    return file.totalBytes;
  }

  if (file.status === "pending") {
    return 0;
  }

  return Math.min(
    file.totalBytes,
    Math.max(file.bytesTransferred, file.bytesEncrypted),
  );
}

function getFileMetaText(file: FileProgress): string | null {
  if (file.totalBytes <= 0) return null;

  if (
    file.status === "inProgress" ||
    file.status === "encrypting" ||
    file.status === "decrypting"
  ) {
    return `${formatBytes(getFileProcessedBytes(file))} / ${formatBytes(file.totalBytes)}`;
  }

  return formatBytes(file.totalBytes);
}

function getHeaderBadgeText(
  snapshot: SyncSnapshot,
  retryCountdown: number,
  connectivityLabel: string,
): string {
  const completedTotal = snapshot.syncedCount + snapshot.deletedCount;

  if (
    connectivityLabel !== "Connected" &&
    snapshot.widgetState !== "preparing" &&
    !snapshot.isActive &&
    snapshot.retryInSecs === 0 &&
    snapshot.failedFiles === 0
  ) {
    return connectivityLabel;
  }

  if (snapshot.retryInSecs > 0) {
    return retryCountdown > 0 ? `Retry in ${retryCountdown}s` : "Retrying";
  }

  if (snapshot.widgetState === "preparing") {
    return "Preparing sync";
  }

  if (snapshot.statusVariant === "error") {
    const verb =
      snapshot.syncDirection === "download"
        ? "download"
        : snapshot.syncDirection === "upload"
          ? "upload"
          : "sync";
    return `${snapshot.failedFiles} of ${snapshot.actualTotal} files failed to ${verb}`;
  }

  if (snapshot.effectiveCompleted) {
    if (snapshot.syncDirection === "download") {
      return `${completedTotal} of ${snapshot.actualTotal} files downloaded`;
    }

    if (snapshot.syncDirection === "delete") {
      return `${snapshot.deletedCount} file${snapshot.deletedCount === 1 ? "" : "s"} deleted`;
    }

    return `${completedTotal} of ${snapshot.actualTotal} files synced`;
  }

  if (snapshot.syncDirection === "download") {
    return `${completedTotal} of ${snapshot.actualTotal} files downloaded`;
  }

  if (snapshot.syncDirection === "delete") {
    return `Deleting ${snapshot.actualTotal} file${snapshot.actualTotal === 1 ? "" : "s"}`;
  }

  return `${completedTotal} of ${snapshot.actualTotal} files synced`;
}

function SyncFileStatusDot({
  outerColor,
  innerColor,
  outerOpacity = 1,
}: SyncFileStatusDotProps) {
  return (
    <div
      className="size-[8px] shrink-0 rounded-full flex items-center justify-center"
      style={{ backgroundColor: outerColor, opacity: outerOpacity }}
      aria-hidden="true"
    >
      <div
        className="size-[4px] rounded-full"
        style={{ backgroundColor: innerColor }}
      />
    </div>
  );
}

function SyncFileStatusBadge({
  variant,
  label,
  percentage,
}: SyncFileStatusBadgeProps) {
  const baseClasses =
    "inline-flex shrink-0 items-center justify-center rounded-[27.518px] bg-[#efefef] text-[#0a0a0a] dark:bg-white/20 dark:text-white gap-[3px] px-[6px] py-[3px]";

  let icon: React.ReactNode;

  if (variant === "progress") {
    icon = (
      <SyncQueueOverallProgress
        percentage={percentage ?? null}
        tone="progress"
        showLabel={false}
        size="xs"
      />
    );
  } else if (variant === "success") {
    icon = <SyncFileStatusDot outerColor="#D1FADF" innerColor="#04C870" />;
  } else if (variant === "error") {
    icon = <SyncFileStatusDot outerColor="#FF6D6133" innerColor="#FF6D61" />;
  } else if (variant === "active") {
    icon = <SyncFileStatusDot outerColor="#D3DFF8" innerColor="#3167DD" />;
  } else if (variant === "neutral") {
    icon = <SyncFileStatusDot outerColor="#FEE4E2" innerColor="#F04438" />;
  } else {
    icon = <SyncFileStatusDot outerColor="#FAEED1" innerColor="#FEB101" />;
  }

  return (
    <span
      className={cn(
        baseClasses,
        "text-[10px] font-medium leading-none tracking-[-0.2px]",
      )}
    >
      {icon}
      <span className="font-geist text-[8px] font-semibold leading-none tracking-[-0.1348px]">
        {label}
      </span>
    </span>
  );
}

const SyncFileItem = memo<SyncFileItemProps>(
  function SyncFileItem({ file }) {
    const isCompleted = file.status === "completed";
    const isDeleted =
      isCompleted &&
      (file.action === "local_delete" || file.action === "remote_delete");
    const isError = file.status === "error";
    // Trim to undefined (not "") so a blank reason falls back to the size meta
    // via `??`. Rust always sends non-blank copy, but stay defensive.
    const errorReason = (isError && file.error?.trim()) || undefined;
    const isEncrypting = file.status === "encrypting";
    const isDecrypting = file.status === "decrypting";
    const isInProgress = file.status === "inProgress";
    const { fileFormat } = getFilePartsFromFileName(file.fileName);
    const fileType = getFileTypeFromExtension(fileFormat || null);
    const { icon: Icon, color } = getFileIcon(
      fileType ? fileType : undefined,
      false,
    );

    let pillText = "Pending";
    let badgeVariant: SyncFileStatusBadgeVariant = "pending";

    if (isDeleted) {
      pillText = "Deleted";
      badgeVariant = "neutral";
    } else if (isCompleted) {
      pillText = file.action === "download" ? "Downloaded" : "Synced";
      badgeVariant = "success";
    } else if (isError) {
      pillText = "Error";
      badgeVariant = "error";
    } else if (isInProgress) {
      pillText = `${file.progressPercent}%`;
      badgeVariant = "progress";
    } else if (isEncrypting) {
      pillText = "Encrypting";
      badgeVariant = "active";
    } else if (isDecrypting) {
      pillText = "Decrypting";
      badgeVariant = "active";
    }

    return (
      <div className="w-full py-[3px]" data-file-item data-testid="file-item">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <div className="flex items-center gap-[6px]">
            <div className="flex size-4 shrink-0 items-center justify-center rounded-[4px]">
              <Icon className={cn("size-4", color)} />
            </div>

            <MiddleTruncatedName
              name={file.fileName}
              className="block min-w-0 flex-1 text-[12px] font-medium leading-none tracking-[-0.24px] text-[#0a0a0a] dark:text-white font-geist"
            />
          </div>

          <div className="flex items-end justify-between gap-2 font-geist">
            {/* Error rows surface the *why* (Rust-authored reason from the
                snapshot's `error` field) in red instead of the byte size; it
                may wrap to two lines, with the "Error" badge staying bottom-
                aligned. All other rows keep the size meta. */}
            <span
              className={cn(
                "min-w-0 text-[10px] font-medium tracking-[-0.2px]",
                errorReason
                  ? "leading-[1.3] text-error-50 line-clamp-2 break-words"
                  : "leading-none text-grey-10/50 dark:text-white/50",
              )}
            >
              {errorReason ?? getFileMetaText(file)}
            </span>

            <SyncFileStatusBadge
              variant={badgeVariant}
              label={pillText}
              percentage={isInProgress ? file.progressPercent : undefined}
            />
          </div>
        </div>
      </div>
    );
  },
  (previous, next) => {
    const previousFile = previous.file;
    const nextFile = next.file;

    return (
      previousFile.status === nextFile.status &&
      previousFile.progressPercent === nextFile.progressPercent &&
      previousFile.bytesTransferred === nextFile.bytesTransferred &&
      previousFile.bytesEncrypted === nextFile.bytesEncrypted &&
      previousFile.action === nextFile.action &&
      previousFile.fileName === nextFile.fileName &&
      previousFile.totalBytes === nextFile.totalBytes &&
      previousFile.error === nextFile.error
    );
  },
);

const SyncStatusDialog: React.FC<SyncStatusDialogProps> = ({
  snapshot,
  open,
  onClose,
  minimized = false,
  onExpand,
  expandOrigin = "bottom-right",
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const engineHealth = useAtomValue(syncEngineHealthAtom);

  const isUnhealthy = engineHealth.status !== "connected";
  const connectivityLabel =
    CONNECTIVITY_STATUS_LABELS[
      engineHealth.status as keyof typeof CONNECTIVITY_STATUS_LABELS
    ] ?? "Disconnected";

  const isInProgress = snapshot.isActive;
  const isRetrying = !snapshot.isActive && snapshot.retryInSecs > 0;
  const isCompleted =
    !snapshot.isActive &&
    !isRetrying &&
    (snapshot.completedFiles > 0 || snapshot.failedFiles > 0);
  const hasFailed = (snapshot.failedFiles > 0 && isCompleted) || isRetrying;
  const effectiveCompleted = snapshot.effectiveCompleted;
  const effectiveInProgress = snapshot.effectiveInProgress;
  const isPreparing = snapshot.widgetState === "preparing";
  const tone = getStatusTone({
    isUnhealthy,
    hasFailed,
    isComplete: effectiveCompleted || isCompleted,
  });
  const canExpand = snapshot.files.length > 0 || Boolean(snapshot.lastError);

  const rawPercent =
    isInProgress &&
    snapshot.totalFiles > 0 &&
    snapshot.overallPercent === 0 &&
    snapshot.bytesExpected === 0
      ? null
      : snapshot.overallPercent;
  const [smoothedPercent, setSmoothedPercent] = useState<number | null>(
    rawPercent,
  );
  const previousSessionRef = useRef<number | null>(null);
  const previousTotalFilesRef = useRef<number>(snapshot.totalFiles);
  const previousFailedFilesRef = useRef<number>(snapshot.failedFiles);
  const previousBytesExpectedRef = useRef<number>(snapshot.bytesExpected);

  useEffect(() => {
    const newSession = snapshot.startedAt !== previousSessionRef.current;
    // A re-plan (bytesExpected changes), a retry that resets transferred bytes,
    // a partial failure (failedFiles grows), or more files queued (totalFiles
    // grows) all legitimately LOWER overallPercent. Re-seed in those cases so
    // the monotonic-max smoothing can't pin the ring at a stale high-water mark
    // for the rest of the session (the "stuck high" bug).
    const replanned =
      snapshot.totalFiles > previousTotalFilesRef.current ||
      snapshot.failedFiles > previousFailedFilesRef.current ||
      snapshot.bytesExpected !== previousBytesExpectedRef.current;

    previousSessionRef.current = snapshot.startedAt;
    previousTotalFilesRef.current = snapshot.totalFiles;
    previousFailedFilesRef.current = snapshot.failedFiles;
    previousBytesExpectedRef.current = snapshot.bytesExpected;

    setSmoothedPercent((previous) =>
      resolveSmoothedPercent(previous, rawPercent, newSession || replanned),
    );
  }, [
    rawPercent,
    snapshot.startedAt,
    snapshot.totalFiles,
    snapshot.failedFiles,
    snapshot.bytesExpected,
  ]);

  const rateSamplesRef = useRef<RateSample[]>([]);
  // Running EMA of the transfer rate. Held in a ref (not state) so each tick
  // folds into the previous smoothed value without re-triggering the effect.
  const smoothedSpeedRef = useRef<number | null>(null);
  // The session the rate samples / smoothed speed belong to. Used to re-seed on
  // a session change — see the comment in the effect below.
  const speedSessionRef = useRef<number | null>(null);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [speedBytesPerSec, setSpeedBytesPerSec] = useState<number | null>(null);

  useEffect(() => {
    if (
      !effectiveInProgress ||
      snapshot.combinedBytesExpected === 0 ||
      snapshot.combinedProgressBytes === 0
    ) {
      rateSamplesRef.current = [];
      smoothedSpeedRef.current = null;
      setEtaSeconds(null);
      setSpeedBytesPerSec(null);
      return;
    }

    // A new session must not inherit the previous session's samples or smoothed
    // speed: the EMA persists a stale value for several ticks (α=0.25), so a
    // carry-over would mis-report speed/ETA at the start of the next sync. The
    // reset guard above only fires at combinedProgressBytes === 0; if a
    // session's first snapshot already carries progress (a coalesced first
    // emit), that guard misses it. Re-seed on startedAt explicitly — exactly as
    // the percent-smoothing effect does with previousSessionRef.
    if (snapshot.startedAt !== speedSessionRef.current) {
      speedSessionRef.current = snapshot.startedAt;
      rateSamplesRef.current = [];
      smoothedSpeedRef.current = null;
    }

    const now = Date.now();
    const samples = rateSamplesRef.current;
    const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;

    if (!lastSample || snapshot.combinedProgressBytes !== lastSample.bytes) {
      samples.push({ time: now, bytes: snapshot.combinedProgressBytes });
      if (samples.length > RATE_WINDOW) {
        samples.splice(0, samples.length - RATE_WINDOW);
      }
    }

    if (samples.length < 2) {
      setEtaSeconds(null);
      return;
    }

    const oldest = samples[0];
    const newest = samples[samples.length - 1];
    const elapsed = (newest.time - oldest.time) / 1000;
    const processedBytes = newest.bytes - oldest.bytes;

    if (elapsed <= 0 || processedBytes <= 0) {
      return;
    }

    const rate = processedBytes / elapsed;
    const smoothed = smoothSpeed(smoothedSpeedRef.current, rate);
    smoothedSpeedRef.current = smoothed;
    setSpeedBytesPerSec(smoothed);

    const remainingBytes =
      snapshot.combinedBytesExpected - snapshot.combinedProgressBytes;
    const eta = remainingBytes / smoothed;
    setEtaSeconds(Math.min(eta, 86400));
  }, [
    effectiveInProgress,
    snapshot.combinedBytesExpected,
    snapshot.combinedProgressBytes,
    snapshot.startedAt,
  ]);

  const [retryCountdown, setRetryCountdown] = useState(0);
  useEffect(() => {
    if (snapshot.retryInSecs <= 0) {
      setRetryCountdown(0);
      return;
    }

    setRetryCountdown(snapshot.retryInSecs);

    const timer = setInterval(() => {
      setRetryCountdown((previous) => {
        if (previous <= 1) {
          clearInterval(timer);
          return 0;
        }

        return previous - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [snapshot.retryInSecs]);

  const toggleExpanded = useCallback(() => {
    if (!canExpand) return;
    setIsExpanded((previous) => !previous);
  }, [canExpand]);

  if (!open) return null;

  if (
    snapshot.totalFiles === 0 &&
    !isInProgress &&
    !isRetrying &&
    !isCompleted
  ) {
    return null;
  }

  // Match the previous version: drive both the circle and the label
  // from `smoothedPercent` directly so they can't disagree. When it's
  // null (the early window before bytesExpected is known), pass null
  // through so SyncQueueOverallProgress renders its indeterminate
  // state instead of showing "0%" alongside a 28%-pulsing circle.
  const displayPercentage =
    effectiveCompleted || isCompleted ? 100 : smoothedPercent;
  const progressLabel =
    displayPercentage === null ? undefined : `${displayPercentage}%`;
  const headerBadgeText = getHeaderBadgeText(
    snapshot,
    retryCountdown,
    isUnhealthy ? connectivityLabel : "Connected",
  );

  // Compact circular form: shown when the sidebar is collapsed or the user
  // minimized the widget. Built after the percentage/tone/badge text so the
  // ring, its label, and the tooltip are driven by the exact same values as
  // the full card — they can never disagree.
  if (minimized) {
    return (
      <SyncStatusMini
        percentage={displayPercentage}
        tone={tone}
        indeterminate={displayPercentage === null}
        statusText={headerBadgeText}
        onExpand={onExpand}
        expandOrigin={expandOrigin}
      />
    );
  }

  const hasTransferringFile = snapshot.files.some(
    (file) => file.status === "inProgress",
  );
  const hasEncryptingFile = snapshot.files.some(
    (file) => file.status === "encrypting",
  );
  const hasDecryptingFile = snapshot.files.some(
    (file) => file.status === "decrypting",
  );

  const isSettled =
    isUnhealthy ||
    isRetrying ||
    hasFailed ||
    effectiveCompleted ||
    isCompleted ||
    isPreparing;

  // Any file actively doing work — transferring OR encrypting OR decrypting.
  // The "transferred / total" byte line tracks this (not just transferring) so
  // it stays on screen through the encrypt/decrypt seam between files instead
  // of blinking out every time a transfer hands off (the "doesn't always show"
  // report). The speed text below stays gated on an actual transfer.
  const hasActiveFile =
    hasTransferringFile || hasEncryptingFile || hasDecryptingFile;

  const showTransferDetails =
    !isSettled && effectiveInProgress && hasActiveFile;

  const compactTransferredText = (() => {
    if (!showTransferDetails) return null;
    const bytes = selectLiveTransferBytes(snapshot);
    if (!bytes) return null;
    return `${formatCompactBytes(bytes.progress)}/${formatCompactBytes(bytes.expected)}`;
  })();

  const compactTrailingText: React.ReactNode = (() => {
    if (isUnhealthy) {
      return (
        <span className="text-error-50 dark:text-[#ff857d]">
          {connectivityLabel}
        </span>
      );
    }
    if (isRetrying) {
      return (
        <span className="text-error-50 dark:text-[#ff857d]">
          {retryCountdown > 0 ? `Retry ${retryCountdown}s` : "Retrying"}
        </span>
      );
    }
    if (hasFailed) {
      return <span className="text-error-50 dark:text-[#ff857d]">Failed</span>;
    }
    if (effectiveCompleted || isCompleted) return "Complete";
    if (isPreparing) return "Preparing";

    if (
      showTransferDetails &&
      hasTransferringFile &&
      speedBytesPerSec !== null &&
      speedBytesPerSec > 0
    ) {
      return `${formatCompactBytes(Math.round(speedBytesPerSec))}/s`;
    }

    if (hasTransferringFile) return null;

    if (hasEncryptingFile) return "Encrypting";
    if (hasDecryptingFile) return "Decrypting";

    return null;
  })();

  const overallTooltip = (
    <div className="flex max-w-[14rem] flex-col gap-1.5">
      <span
        className={cn(
          "inline-flex w-fit items-center rounded-full px-[4.45px] py-[2.25px] text-[10px] font-medium leading-none tracking-[-0.2px]",
          tone === "error"
            ? "bg-error-100/70 text-error-40 dark:bg-error-50/15 dark:text-error-50"
            : tone === "success"
              ? "bg-success-100/70 text-success-40 dark:bg-success-50/15 dark:text-success-50"
              : "bg-primary-100/70 text-primary-40 dark:bg-primary-50/20 dark:text-primary-80",
        )}
      >
        {headerBadgeText}
      </span>

      {snapshot.lastError && (isRetrying || hasFailed) ? (
        <span className="text-[10px] font-medium leading-[1.3] tracking-[-0.2px] text-error-50">
          {snapshot.lastError}
        </span>
      ) : effectiveInProgress && etaSeconds !== null && etaSeconds > 0 ? (
        <span className="text-[10px] font-medium leading-[1.3] tracking-[-0.2px] text-grey-40 dark:text-grey-light-600">
          ~{formatEta(etaSeconds)} remaining
        </span>
      ) : isPreparing ? (
        <span className="text-[10px] font-medium leading-[1.3] tracking-[-0.2px] text-grey-40 dark:text-grey-light-600">
          Scanning the sync folder for changes.
        </span>
      ) : null}
    </div>
  );

  return (
    <div
      onClick={(event: React.MouseEvent) => event.stopPropagation()}
      className={cn(
        "w-[239px] animate-widget-grow-0.3",
        expandOrigin === "bottom-left"
          ? "origin-bottom-left"
          : "origin-bottom-right",
      )}
    >
      <div className="w-full overflow-hidden rounded-[12px] shadow-lg bg-[#d8d8d9] dark:bg-[#4b4b4c]">
        <div className="flex items-start gap-[6px] p-[10px]">
          <div
            role={canExpand ? "button" : undefined}
            tabIndex={canExpand ? 0 : undefined}
            onClick={toggleExpanded}
            onKeyDown={(event) => {
              if (!canExpand) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleExpanded();
              }
            }}
            data-testid="sync-status-toggle"
            className={cn(
              "min-w-0 flex-1 text-left outline-none",
              canExpand ? "cursor-pointer" : "cursor-default",
            )}
          >
            <div className="flex items-center gap-[6px]">
              <span className="flex-1 truncate text-[14px] font-medium leading-none tracking-[-0.4px] text-[#27272a] dark:text-white font-inter">
                Sync Queue
              </span>

              {canExpand &&
                (isExpanded ? (
                  <ChevronDown className="size-4 stroke-[1.5px] shrink-0 text-[#71717B] dark:text-white" />
                ) : (
                  <ChevronUp className="size-4 stroke-[1.5px] shrink-0 text-[#71717B] dark:text-white" />
                ))}
              {onClose && (
                <button
                  type="button"
                  aria-label="Close sync status"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onClose();
                  }}
                  data-role="close-button"
                  className="mt-[1px] inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[#71717B] transition-colors hover:text-black dark:text-white dark:hover:text-white"
                >
                  <Icons.Close className="size-3 pointer-events-none" />
                </button>
              )}
            </div>

            <div className="mt-1 flex items-center justify-between gap-[6px]">
              <SyncQueueOverallProgress
                percentage={displayPercentage}
                label={progressLabel}
                tone={tone}
                indeterminate={displayPercentage === null}
                tooltipContent={overallTooltip}
                detailsStart={compactTransferredText}
                detailsEnd={compactTrailingText}
                detailsSize="sm"
                className="w-full"
              />
            </div>
          </div>
        </div>

        <div
          className="overflow-hidden transition-[max-height,opacity] duration-300 ease-in-out"
          data-testid="sync-status-body"
          style={{
            maxHeight: isExpanded ? `${BODY_MAX_HEIGHT_REM}rem` : "0",
            opacity: isExpanded ? 1 : 0,
          }}
        >
          <div className="border-t border-black/10 dark:border-white/10">
            {snapshot.lastError && (isRetrying || hasFailed) && (
              <p className="px-[10px] pt-2 text-[10px] font-medium leading-[1.3] tracking-[-0.2px] text-error-50 line-clamp-2 break-words">
                {snapshot.lastError}
              </p>
            )}

            <div className="max-h-[11.5rem] overflow-y-auto px-[10px] py-1.5 flex flex-col gap-1.5">
              {/* Only build the per-file rows when the body is actually visible.
                  The collapsed body is CSS-hidden (max-height:0) but the dialog
                  re-renders up to ~4x/sec during a sync; mapping the whole file
                  list each time was wasted reconciliation. The wrapper stays
                  mounted so the open/close transition still animates, and the
                  list renders synchronously on first expand (no empty flash). */}
              {isExpanded &&
                snapshot.files.map((file) => (
                  <SyncFileItem key={file.path} file={file} />
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SyncStatusDialog;
