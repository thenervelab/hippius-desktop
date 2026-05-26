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
}): StatusTone {
  if (options.isUnhealthy || options.hasFailed) return "error";
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
            <span className="min-w-0 text-[10px] font-medium leading-none tracking-[-0.2px] text-grey-10/50 dark:text-white/50 ">
              {getFileMetaText(file)}
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

  useEffect(() => {
    if (snapshot.startedAt !== previousSessionRef.current) {
      previousSessionRef.current = snapshot.startedAt;
      previousTotalFilesRef.current = snapshot.totalFiles;
      setSmoothedPercent(rawPercent);
      return;
    }

    if (snapshot.totalFiles > previousTotalFilesRef.current) {
      previousTotalFilesRef.current = snapshot.totalFiles;
      setSmoothedPercent(rawPercent);
      return;
    }

    previousTotalFilesRef.current = snapshot.totalFiles;

    if (rawPercent === null) {
      setSmoothedPercent(null);
      return;
    }

    setSmoothedPercent((previous) => {
      if (previous === null) return rawPercent;
      if (rawPercent >= 100) return 100;
      return Math.max(previous, rawPercent);
    });
  }, [rawPercent, snapshot.startedAt, snapshot.totalFiles]);

  const rateSamplesRef = useRef<RateSample[]>([]);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [speedBytesPerSec, setSpeedBytesPerSec] = useState<number | null>(null);

  useEffect(() => {
    if (
      !effectiveInProgress ||
      snapshot.combinedBytesExpected === 0 ||
      snapshot.combinedProgressBytes === 0
    ) {
      rateSamplesRef.current = [];
      setEtaSeconds(null);
      setSpeedBytesPerSec(null);
      return;
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
    setSpeedBytesPerSec(rate);

    const remainingBytes =
      snapshot.combinedBytesExpected - snapshot.combinedProgressBytes;
    const eta = remainingBytes / rate;
    setEtaSeconds(Math.min(eta, 86400));
  }, [
    effectiveInProgress,
    snapshot.combinedBytesExpected,
    snapshot.combinedProgressBytes,
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

  const showTransferDetails =
    !isSettled && effectiveInProgress && hasTransferringFile;

  const compactTransferredText = (() => {
    if (!showTransferDetails) return null;
    if (
      (snapshot.intentActive ?? false) &&
      (snapshot.intentTotalBytes ?? 0) > 0
    ) {
      return `${formatCompactBytes(snapshot.intentCompletedBytes ?? 0)}/${formatCompactBytes(snapshot.intentTotalBytes ?? 0)}`;
    }
    if (snapshot.bytesExpected > 0) {
      return `${formatCompactBytes(snapshot.progressBytes)}/${formatCompactBytes(snapshot.bytesExpected)}`;
    }
    return null;
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
            ? "bg-error-100/70 text-error-40"
            : tone === "success"
              ? "bg-success-100/70 text-success-40"
              : "bg-primary-100/70 text-primary-40",
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
      className="w-[239px] "
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
              {snapshot.files.map((file) => (
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
