"use client";

import { FC, useMemo } from "react";
import { useAtomValue } from "jotai";
import { snapshotAtom } from "@/lib/hooks/useSyncSnapshot";
import { cn } from "@/lib/utils";
import { Icons } from "@/components/ui";

interface SyncProgressBadgeProps {
  /** The file's actual name (used to match against active sync files) */
  fileName?: string;
  /** The file's source path (more precise match) */
  source?: string;
  /** Static sync status from the file list */
  syncStatus?: "synced" | "pending" | "unknown";
  /** Compact mode shows just an icon + short text */
  compact?: boolean;
  className?: string;
}

/**
 * Shows live sync progress for a file by cross-referencing
 * the sync snapshot. Falls back to a static "Pending" badge
 * if no active progress is found.
 */
const SyncProgressBadge: FC<SyncProgressBadgeProps> = ({
  fileName,
  source,
  syncStatus,
  compact = false,
  className,
}) => {
  const snapshot = useAtomValue(snapshotAtom);

  // Find this file in the active sync snapshot
  const fileProgress = useMemo(() => {
    if (!snapshot.files.length) return null;

    // Try matching by source path first (most precise)
    if (source) {
      const match = snapshot.files.find((f) => f.path === source);
      if (match) return match;
    }

    // Fall back to matching by file name
    if (fileName) {
      const match = snapshot.files.find((f) => f.fileName === fileName);
      if (match) return match;
    }

    return null;
  }, [snapshot.files, source, fileName]);

  // Active sync progress — show live status
  if (fileProgress) {
    const { status, progressPercent, action } = fileProgress;

    if (status === "completed") return null;

    const statusConfig = {
      encrypting: {
        label: compact ? "Encrypting" : `Encrypting ${progressPercent}%`,
        badgeClass: "bg-warning-100 text-warning-40 border-warning-80",
        iconClass: "text-warning-50",
      },
      decrypting: {
        label: compact ? "Decrypting" : `Decrypting ${progressPercent}%`,
        badgeClass: "bg-warning-100 text-warning-40 border-warning-80",
        iconClass: "text-warning-50",
      },
      inProgress: {
        label: compact
          ? action === "upload" ? "Uploading" : "Downloading"
          : `${action === "upload" ? "Uploading" : "Downloading"} ${progressPercent}%`,
        badgeClass: "bg-primary-100 text-primary-40 border-primary-80",
        iconClass: "text-primary-50",
      },
      pending: {
        label: "Queued",
        badgeClass: "bg-grey-90 text-grey-50 border-grey-80",
        iconClass: "text-grey-50",
      },
      error: {
        label: "Failed",
        badgeClass: "bg-error-100 text-error-40 border-error-80",
        iconClass: "text-error-50",
      },
    };

    const config = statusConfig[status] || statusConfig.pending;

    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border flex-shrink-0",
          config.badgeClass,
          className,
        )}
      >
        {(status === "encrypting" || status === "decrypting" || status === "inProgress") && (
          <Icons.Refresh className={cn("size-3 animate-spin", config.iconClass)} />
        )}
        {status === "error" && (
          <Icons.InfoCircle className={cn("size-3", config.iconClass)} />
        )}
        {config.label}
      </span>
    );
  }

  // No active progress — show static pending badge if applicable
  if (syncStatus === "pending") {
    return (
      <span
        className={cn(
          "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-warning-100 text-warning-40 border border-warning-80 flex-shrink-0",
          className,
        )}
        title="Not yet uploaded — will sync automatically"
      >
        Pending upload
      </span>
    );
  }

  return null;
};

export default SyncProgressBadge;
