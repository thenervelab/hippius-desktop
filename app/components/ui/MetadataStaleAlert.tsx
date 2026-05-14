"use client";

/**
 * Per-drive banner shown when the bounded-retry "first reconcile"
 * fails to refresh the server's authoritative `remote_timestamps`
 * map. Surfaces the condition the previous fix-by-logout pattern
 * silently hid: the "DATE UPLOADED" column may be sparse until a
 * later sync cycle backfills the missing timestamps.
 *
 * Reads `metadataStaleLabelsAtom`, owned by `useMetadataStale`
 * (mounted via `SyncEventLogger`). The banner self-hides when the
 * label disappears from the atom — the listener clears entries on
 * the next `hcfs_activity_updated` event.
 *
 * The user has no actionable affordance here (no retry button) —
 * the next normal sync cycle handles it. The banner exists to
 * inform, not to gate.
 */

import React from "react";
import { useAtomValue } from "jotai";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { metadataStaleLabelsAtom } from "@/app/lib/global-atoms/unpinAtoms";

interface MetadataStaleAlertProps {
  /**
   * Drive label to check. When `null` (e.g. the "All" tab is
   * selected), the banner shows if ANY drive is stale, since the
   * combined view aggregates across all drives.
   */
  label: string | null;
  className?: string;
}

export const MetadataStaleAlert: React.FC<MetadataStaleAlertProps> = ({
  label,
  className,
}) => {
  const stale = useAtomValue(metadataStaleLabelsAtom);

  // For a specific drive: show only when that drive is stale.
  // For the "All" tab (label == null): show whenever any drive is
  // stale, since the table aggregates entries from all drives.
  if (label !== null) {
    if (!stale.has(label)) return null;
  } else if (stale.size === 0) {
    return null;
  }

  const affectedCount = stale.size;
  const heading =
    label !== null
      ? "Couldn't refresh upload dates for this folder"
      : affectedCount === 1
        ? "Couldn't refresh upload dates for 1 folder"
        : `Couldn't refresh upload dates for ${affectedCount} folders`;

  return (
    <div
      className={cn(
        "flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg",
        className
      )}
      role="status"
    >
      <div className="flex-shrink-0 mt-0.5">
        <AlertCircle className="size-5 text-amber-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-amber-800">{heading}</p>
        <p className="text-xs text-amber-700 mt-1">
          The &ldquo;DATE UPLOADED&rdquo; column may show &ldquo;—&rdquo; for some files.
          This clears automatically the next time syncing succeeds.
        </p>
      </div>
    </div>
  );
};

export default MetadataStaleAlert;
