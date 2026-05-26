import { FC, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileTypes } from "@/lib/types/fileTypes";
import { getFileIcon } from "@/lib/utils/fileTypeUtils";
import { cn } from "@/lib/utils";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { buildFolderPath } from "@/app/utils/folderPathUtils";
import MiddleTruncatedName from "@/components/ui/MiddleTruncatedName";
import SharedLinkBadge from "@/components/page-sections/drive/SharedLinkBadge";
import SyncQueueOverallProgress from "@/app/(pages)/SyncQueueOverallProgress";
import CustomTooltip2 from "@/components/ui/CustomTooltip2";
import {
  useFileLiveProgress,
  type LiveFileStatus,
} from "@/app/lib/hooks/useFileLiveProgress";

// Mirrors `FormattedUserFile.syncStatus`. `failed` is the FE-facing label for a
// snapshot file whose Rust-side `FileProgressStatus` is `Error` — e.g. an
// upload that hit HTTP 402 and won't be retried this cycle. We deliberately
// expose it as a separate status (rather than collapsing into `uploading`) so
// the icon, tooltip, and pulse semantics stay truthful.
type SyncStatusType =
  | "synced"
  | "pending"
  | "uploading"
  | "downloading"
  | "failed"
  | "unknown"
  | "excluded";

type NameCellProps = {
  rawName: string;
  actualName?: string;
  arionHash: string;
  className?: string;
  isAssigned: boolean;
  fileType?: FileTypes;
  onShowDetails?: () => void;
  isPreviewable?: boolean;
  isFolder?: boolean;
  source?: string;
  mainReqHash?: string;
  syncStatus?: SyncStatusType;
  /** Drive label for this file. Required for the per-file shared
   *  badge to look the file up in the shares index — the badge
   *  silently no-ops when missing, so old call sites keep working. */
  label?: string;
  /** Parent folder's path inside the sync drive (e.g.
   *  "MyDrive/Photos/2024"). Set by ExpandedFolderRows so that clicking
   *  a folder name in an inline-expanded subtree produces a URL that
   *  reflects the full path, not whatever the current URL still shows.
   *  When unset, the previous URL-driven behaviour is preserved. */
  parentSubFolderPath?: string;
  /** How long (ms) to keep the "Synced" pill visible after a file
   *  finishes syncing during the current session. After this elapses
   *  the badge hides so static, long-synced rows stay visually quiet.
   *  Defaults to 5000ms. */
  syncedBadgeMs?: number;
};

type BadgeStatus = LiveFileStatus;

/**
 * Maps the row's static `syncStatus` prop (server-reported) plus the
 * live snapshot status into a single badge state. Live wins so an
 * upload mid-flight overrides a stale "pending" from the index; the
 * fallback narrows the broader `SyncStatusType` union (which also
 * carries the non-visible "unknown" / "excluded" tags) into just the
 * five states the badge renders.
 */
function resolveBadgeStatus(
  live: LiveFileStatus | null,
  prop: SyncStatusType | undefined,
): BadgeStatus | null {
  if (live) return live;
  if (!prop) return null;
  if (
    prop === "pending" ||
    prop === "uploading" ||
    prop === "downloading" ||
    prop === "failed" ||
    prop === "synced"
  ) {
    return prop;
  }
  return null;
}

/** Inline status indicator shown after the file name. Matches the Figma
 *  dashboard-table badges: solid pills for terminal states ("Pending",
 *  "Failed") and the small progress circle from the sync widget for live
 *  transfers. The "synced" indicator auto-hides after `syncedBadgeMs` so
 *  the row only celebrates fresh transitions — already-synced files at
 *  page load remain visually quiet.
 */
const FileStatusBadge: FC<{
  status: BadgeStatus | null;
  progressPercent: number | null;
  syncedBadgeMs: number;
}> = ({ status, progressPercent, syncedBadgeMs }) => {
  // Tracks whether the live `synced` indicator is still within its
  // post-completion window. We start at `null` so the initial mount
  // doesn't count as a transition (already-synced rows shouldn't flash).
  const [syncedExpired, setSyncedExpired] = useState(false);
  const prevStatusRef = useRef<BadgeStatus | null>(null);

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    if (status !== "synced") {
      setSyncedExpired(false);
      return;
    }
    if (prev === null || prev === "synced") {
      // Initial mount as already-synced, or no real transition — keep the
      // badge hidden so legacy rows don't sprout a fresh-completion pill.
      setSyncedExpired(true);
      return;
    }
    setSyncedExpired(false);
    const timer = setTimeout(() => setSyncedExpired(true), syncedBadgeMs);
    return () => clearTimeout(timer);
  }, [status, syncedBadgeMs]);

  if (!status) return null;

  // Shared pill styling for the terminal text states. Tracks Figma nodes
  // 4045:151603 (Pending) and 4045:151627 (Failed): a fully-coloured
  // rounded badge with a single-line label sized for the table row.
  const pillBase =
    "inline-flex h-[18px] shrink-0 items-center justify-center rounded-full px-[8px] pb-[3px] pt-[2px]";
  const pillLabel =
    "font-geist text-[10px] font-medium leading-none tracking-[-0.2px] whitespace-nowrap";

  // Hover tooltips mirror the wording from the legacy SyncStatusHandler2
  // header so the user gets the same "where is this file in the sync
  // pipeline" cue even though the per-row badge has no inline text for
  // the progress states. The percent on uploading/downloading is the
  // bucketed value already; the snapshot may not have produced one yet
  // (indeterminate) in which case we omit it from the label.
  const renderPercent = (n: number | null) =>
    n === null ? "" : ` ${n}%`;

  if (status === "pending") {
    return (
      <CustomTooltip2
        side="top"
        tooltipContent="Waiting in the sync queue. The transfer will start shortly."
      >
        <span
          data-testid="sync-status-pending"
          className={cn(pillBase, "bg-warning-200")}
        >
          <span className={cn(pillLabel, "text-white")}>Pending</span>
        </span>
      </CustomTooltip2>
    );
  }

  if (status === "failed") {
    return (
      <CustomTooltip2
        side="top"
        tooltipContent="This file failed to sync. Please try again."
      >
        <span
          data-testid="sync-status-failed"
          aria-label="Upload failed"
          className={cn(pillBase, "bg-[#FF6D61]")}
        >
          <span className={cn(pillLabel, "text-white")}>Failed</span>
        </span>
      </CustomTooltip2>
    );
  }

  if (status === "synced") {
    if (syncedExpired) return null;
    return (
      <span
        data-testid="sync-status-synced"
        aria-label="Synced"
        className="inline-flex shrink-0 items-center"
      >
        <SyncQueueOverallProgress
          percentage={100}
          tone="progress"
          showLabel={false}
          size="sm"
          tooltipContent="Successfully synced to the Hippius network."
        />
      </span>
    );
  }

  // uploading / downloading — small progress circle, no label text per
  // the Figma. Falls back to indeterminate when the snapshot hasn't
  // reported a percentage yet so we don't display a stale 0%.
  const testId =
    status === "uploading"
      ? "sync-status-uploading"
      : "sync-status-downloading";
  const indeterminate = progressPercent === null;
  const tooltipText =
    status === "uploading"
      ? `Uploading${renderPercent(progressPercent)} — Your file is being synced to the Hippius network. This process may take a few minutes.`
      : `Downloading${renderPercent(progressPercent)} — Your file is being downloaded from the Hippius network.`;
  return (
    <span
      data-testid={testId}
      aria-label={status === "uploading" ? "Uploading" : "Downloading"}
      className="inline-flex shrink-0 items-center"
    >
      <SyncQueueOverallProgress
        percentage={progressPercent}
        tone="progress"
        showLabel={false}
        size="sm"
        indeterminate={indeterminate}
        tooltipContent={tooltipText}
      />
    </span>
  );
};

const NameCell: FC<NameCellProps> = ({
  rawName,
  actualName,
  arionHash,
  className,
  fileType,
  isPreviewable = false,
  isFolder = false,
  source,
  mainReqHash,
  syncStatus,
  label,
  parentSubFolderPath,
  syncedBadgeMs = 5000,
}) => {
  const { icon: Icon, color } = getFileIcon(fileType, isFolder);
  const { getParam } = useUrlParams();
  // Folder rows never carry their own sync state — the badge only renders
  // for files, so skip the snapshot subscription work for folders.
  const live = useFileLiveProgress(actualName, rawName);
  const badgeStatus = isFolder
    ? null
    : resolveBadgeStatus(live.status, syncStatus);

  const mainFolderHash = getParam("mainFolderCid", "");
  const folderActualName = isFolder ? actualName || "" : "";
  // When the caller hands us a runtime-known parent path (inline-expanded
  // subtree), its first segment is the authoritative `mainFolderActualName`
  // and the whole string is the authoritative `subFolderPath`. Falling back
  // to URL params at this point would re-introduce the deep-click bug.
  const trimmedParentPath =
    parentSubFolderPath?.replace(/^\/+|\/+$/g, "") ?? "";
  const parentMainFolder = trimmedParentPath
    ? (trimmedParentPath.split("/")[0] ?? "")
    : "";
  const mainFolderActualName = trimmedParentPath
    ? parentMainFolder
    : getParam("mainFolderActualName", isFolder ? actualName || "" : "");
  const subFolderPath = trimmedParentPath
    ? trimmedParentPath
    : getParam("subFolderPath", "");

  const effectiveMainFolderHash = mainFolderHash || arionHash;

  // Build the folder path for navigation
  const {
    mainFolderActualName: newMainFolder,
    subFolderPath: newSubFolderPath,
  } = buildFolderPath(
    folderActualName,
    effectiveMainFolderHash,
    mainFolderActualName || folderActualName,
    subFolderPath,
  );

  const folderUrl = {
    pathname: "/files",
    query: {
      mainFolderCid: effectiveMainFolderHash ?? "",
      folderCid: arionHash ?? "",
      folderName: rawName ?? "",
      folderActualName: actualName ?? "",
      mainFolderActualName: newMainFolder ?? "",
      subFolderPath: newSubFolderPath ?? "",
      folderSource: source || "",
      mainReqHash: mainReqHash,
    },
  };

  return (
    <div className={cn("w-full min-w-0", className)} draggable={false}>
      {isFolder ? (
        <Link
          href={folderUrl}
          prefetch={false}
          draggable={false}
          className="cursor-pointer"
        >
          <div className="flex items-center min-w-0">
            <Icon className={cn("size-5 mr-2 flex-shrink-0", color)} />
            <MiddleTruncatedName
              name={rawName}
              className="text-grey-20 dark:text-grey-light-100 transition"
              textClassName="hover:text-primary-40 hover:underline"
            />
          </div>
        </Link>
      ) : (
        // Status badge sits at the right edge of the name cell — same x as
        // the hover preview icon added by VideoDialogTrigger / ImageDialogTrigger
        // / PdfDialogTrigger. The trigger's hover gradient layers on top, so
        // the badge fades out as the play/eye icon appears.
        <div className="flex items-center min-w-0 w-full gap-2">
          <div className="flex items-center min-w-0 flex-1">
            <Icon className={cn("size-5 mr-2 flex-shrink-0", color)} />
            <MiddleTruncatedName
              name={rawName}
              className="text-grey-20 dark:text-grey-light-100"
              textClassName={cn(
                isPreviewable &&
                  "group-hover:text-primary-50 group-hover:underline cursor-pointer",
              )}
              suffix={
                <SharedLinkBadge
                  label={label}
                  actualName={actualName}
                  isFolder={isFolder}
                  className="ml-1.5"
                />
              }
            />
          </div>
          <FileStatusBadge
            status={badgeStatus}
            progressPercent={live.progressPercent}
            syncedBadgeMs={syncedBadgeMs}
          />
        </div>
      )}
    </div>
  );
};

export default NameCell;
