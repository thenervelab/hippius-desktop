"use client";

import { Skeleton } from "@/components/ui";

interface FolderRowSkeletonProps {
  /**
   * When true, renders a small pill placeholder next to the folder name
   * (mirrors the Syncing/Paused/Error badge on Local rows).
   */
  hasStatusBadge?: boolean;
}

/**
 * Skeleton placeholder shaped like a real Local / Remote folder row.
 * Uses the shared `Skeleton` primitive so the pulse animation and
 * light/dark surface colors stay consistent with the rest of the app.
 */
export default function FolderRowSkeleton({
  hasStatusBadge = false,
}: FolderRowSkeletonProps) {
  return (
    <div className="flex items-start justify-between p-3">
      <div className="flex-1 min-w-0">
        {/* Top row — icon + name + (optional pill) + separator + meta blocks */}
        <div className="flex items-center gap-[7px] flex-wrap">
          <Skeleton variant="circle" width={16} height={16} />
          <Skeleton width={120} height={14} />
          {hasStatusBadge && (
            <Skeleton width={68} height={22} className="rounded-full" />
          )}
          <span
            aria-hidden="true"
            className="h-4 w-px bg-grey-80 dark:bg-[#3a3a3a] flex-shrink-0"
          />
          <Skeleton width={56} height={14} />
          <Skeleton width={64} height={14} />
          <Skeleton width={140} height={14} />
        </div>

        {/* Subtitle line — path (Local) or device name (Remote) */}
        <Skeleton width={220} height={14} className="mt-2 ml-6" />
      </div>

      {/* 3-dot action button placeholder */}
      <Skeleton width={32} height={32} className="rounded-md flex-shrink-0" />
    </div>
  );
}
