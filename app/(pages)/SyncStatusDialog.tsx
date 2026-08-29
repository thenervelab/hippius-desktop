"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtomValue } from "jotai";

import * as Icons from "@/components/ui/icons";
import MiddleTruncatedName from "@/components/ui/MiddleTruncatedName";
import {
  cn,
  getFilePartsFromFileName,
  getFileTypeFromExtension,
} from "@/lib/utils";
import { formatBytes } from "@/lib/utils/formatBytes";

import { hasActionableFailures } from "../lib/sync/actionableFailures";
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
  resolveSmoothedEta,
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
  /** True when Rust flagged this row's failure as self-resolving. Passed in
   * rather than derived here: the classification is Rust's (the reason string
   * is display copy, not a contract), and the row only joins by path. */
  isRetrying?: boolean;
}

type SyncFileStatusBadgeVariant =
  | "progress"
  | "pending"
  | "success"
  | "error"
  // A failure the engine resolves by itself on the next cycle. Amber, not red:
  // red tells the user to act, and there is nothing here for them to do.
  | "retrying"
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
  } else if (variant === "retrying") {
    icon = <SyncFileStatusDot outerColor="#FAEED1" innerColor="#FEB101" />;
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
  function SyncFileItem({ file, isRetrying = false }) {
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
      pillText = isRetrying ? "Retrying" : "Error";
      badgeVariant = isRetrying ? "retrying" : "error";
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
      previousFile.error === nextFile.error &&
      // Without this the row keeps its stale badge: the file fields are
      // identical across the frame where Rust first flags it as retrying.
      previous.isRetrying === next.isRetrying
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

  // Rust flags the errored rows that retry themselves; the row joins by path.
  // A Set (not `.includes`) so a large failing batch stays O(1) per row.
  const retryingPaths = useMemo(
    () => new Set(snapshot.transientErrorPaths ?? []),
    [snapshot.transientErrorPaths],
  );

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
  const hasFailed =
    (hasActionableFailures(snapshot) && isCompleted) || isRetrying;
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
  // Running EMA of the derived ETA. Smoothing the speed alone leaves the ETA
  // lurching when the plan grows (numerator steps up); this damps that. Held in
  // a ref for the same reason as the speed EMA. Reset alongside the speed EMA.
  const smoothedEtaRef = useRef<number | null>(null);
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
      smoothedEtaRef.current = null;
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
      smoothedEtaRef.current = null;
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
      smoothedEtaRef.current = null;
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
    // Cap the RAW estimate before smoothing so a transient huge value can't
    // spike the EMA, then EMA-smooth the ETA itself — the speed is already
    // smoothed, but the numerator steps up as the plan grows, so the raw ETA
    // still lurches without this (F-4).
    const rawEta = Math.min(remainingBytes / smoothed, 86400);
    const smoothedEta = resolveSmoothedEta(smoothedEtaRef.current, rawEta);
    smoothedEtaRef.current = smoothedEta;
    setEtaSeconds(smoothedEta);
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

  // Render the "Preparing sync…" state even with no files yet. During the
  // preparing window (Rust marks `widgetState="preparing"` + `widgetVisible` the
  // moment a folder is added, before the engine has built the plan) the snapshot
  // has `totalFiles === 0` and is not yet in-progress/retrying/completed — so
  // without the `!isPreparing` guard this early-return swallowed the preparing
  // card entirely and the widget only appeared once files populated (the
  // "widget takes 5-10s to show after adding a folder" report). `isPreparing`
  // is driven by `widgetState`, which the handler already gates `widgetVisible`
  // on, so this can't render a stray empty card outside a real preparing window.
  if (
    snapshot.totalFiles === 0 &&
    !isInProgress &&
    !isRetrying &&
    !isCompleted &&
    !isPreparing
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

  // The byte readout (and now the speed suffix) only need the session to be in
  // progress with a known total — they must NOT also require an active-status
  // file, or they blink out during the all-pending/indexing seam and on every
  // encrypt→upload / file→file handoff (files queued or encrypting but none
  // momentarily in `inProgress`) even though the plan size is known and bytes
  // keep climbing (F-5, "speed only shows intermittently").
  // `selectLiveTransferBytes` returns null when bytesExpected===0, so the
  // genuine preparing phase (no total yet) still shows "Preparing" rather than a
  // misleading 0B/0B line; the speed suffix additionally requires a positive
  // measured rate, so it only appears once a real transfer has been observed.
  const showTransferBytes = !isSettled && effectiveInProgress;

  const compactTransferredText = (() => {
    // Startup window: before the engine's first session snapshot, show the
    // local-pending summary ("N files · X") the backend computed from the
    // on-disk-vs-baseline diff, so the user sees the scope of pending work
    // immediately instead of a bare "Preparing". Supersedes once the live
    // session takes over (widgetState leaves "preparing").
    if (isPreparing) {
      const f = snapshot.preparingPendingFiles ?? 0;
      if (f > 0) {
        const b = snapshot.preparingPendingBytes ?? 0;
        return `${f.toLocaleString()} file${f === 1 ? "" : "s"} · ${formatCompactBytes(b)}`;
      }
      // File-watcher cycles have no startup summary; show the LIVE
      // indexing counters instead ("1,234 files scanned" next to the
      // trailing "Preparing" label) so a long scan reads as active work.
      const scanned = snapshot.preparingScannedFiles ?? 0;
      if (scanned > 0) {
        return `${scanned.toLocaleString()} file${scanned === 1 ? "" : "s"} scanned`;
      }
      const fetchTotal = snapshot.preparingFetchTotalEntries ?? 0;
      if (fetchTotal > 0) {
        const fetched = snapshot.preparingFetchedEntries ?? 0;
        return `${fetched.toLocaleString()}/${fetchTotal.toLocaleString()} entries`;
      }
      return null;
    }
    if (!showTransferBytes) return null;
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

    // Show the speed whenever the session is actively transferring and we have
    // a real measured rate — gated on `showTransferBytes` (the same condition
    // the "X of Y bytes" line uses), NOT on `hasTransferringFile`. The smoothed
    // speed (`smoothedSpeedRef`) is retained across the encrypt→upload and
    // file→file seams where no file is momentarily in `inProgress`; the old
    // `hasTransferringFile` gate blanked the suffix on every one of those seams
    // even though bytes kept climbing (the reported "speed only shows
    // intermittently"). Falls through to the Encrypting/Decrypting labels only
    // when there is no positive rate yet (e.g. the initial encrypt before any
    // upload). F-5.
    if (
      showTransferBytes &&
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
        "w-[239px]",
        // In the sidebar the rail animates its width with ease-in-out; use the
        // matched soft grow so the card settles in lockstep with the rail. The
        // portal overlay has no rail to track, so it keeps the standalone pop.
        expandOrigin === "bottom-left"
          ? "animate-widget-grow-soft-0.3 origin-bottom-left"
          : "animate-widget-grow-0.3 origin-bottom-right",
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
                  <SyncFileItem
                    key={file.path}
                    file={file}
                    isRetrying={retryingPaths.has(file.path)}
                  />
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SyncStatusDialog;
