"use client";

import { FC, Fragment } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One node in the drive breadcrumb path. The last segment in the array is
 * rendered "active" (current location, no click handler executed). All
 * preceding segments are rendered "inactive" and clickable.
 */
export interface BreadcrumbSegment {
  /** Visible label, e.g. the sync folder display name or a nested folder name. */
  label: string;
  /** Click handler that moves the user back to this segment. */
  onClick?: () => void;
  /** Optional tooltip — useful when `label` is truncated. */
  title?: string;
}

interface SyncFolderBreadcrumbProps {
  /** Click handler for the fixed root segment — switches drive to the cards view. */
  onLocalClick: () => void;
  /**
   * Label of the fixed root segment. "Local" for locally synced drives; the
   * drive view passes "Remote" when browsing a server-only drive, since
   * nothing about that drive is local to this machine. Both click through to
   * the same cards view (which lists both sections).
   */
  rootLabel?: string;
  /**
   * Path segments rendered AFTER "Local". Empty when the user is on the
   * Local cards view. First entry is the top-level sync folder; subsequent
   * entries are nested folders the user has dived into.
   */
  segments: BreadcrumbSegment[];
  /** Optional overrides for the outer nav — used when embedding inline with action buttons. */
  className?: string;
}

const SEGMENT_BASE = cn(
  "font-geist text-[14px] font-medium leading-normal tracking-[-0.28px]",
  "whitespace-nowrap",
);

const SEGMENT_INACTIVE = cn(
  "text-black-700 dark:text-grey-light-200 opacity-40",
  "hover:opacity-100 transition-opacity cursor-pointer",
);

const SEGMENT_ACTIVE = "text-black-700 dark:text-grey-light-200";

const CHEVRON_CLASSES =
  "size-[14px] text-black-700 dark:text-grey-light-200 opacity-40 shrink-0";

const SyncFolderBreadcrumb: FC<SyncFolderBreadcrumbProps> = ({
  onLocalClick,
  segments,
  className,
  rootLabel = "Local",
}) => {
  const hasSegments = segments.length > 0;

  return (
    <nav
      aria-label="Sync folder breadcrumb"
      className={cn(
        "flex items-center gap-1 mt-6 mb-5 select-none min-w-0",
        className,
      )}
    >
      <button
        type="button"
        onClick={onLocalClick}
        className={cn(
          SEGMENT_BASE,
          hasSegments ? SEGMENT_INACTIVE : SEGMENT_ACTIVE,
          "bg-transparent border-0 p-0 m-0",
        )}
      >
        {rootLabel}
      </button>
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        return (
          <Fragment key={`${index}-${segment.label}`}>
            <ChevronRight aria-hidden className={CHEVRON_CLASSES} />
            {isLast ? (
              <span
                className={cn(
                  SEGMENT_BASE,
                  SEGMENT_ACTIVE,
                  "truncate max-w-[20rem]",
                )}
                title={segment.title ?? segment.label}
              >
                {segment.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={segment.onClick}
                className={cn(
                  SEGMENT_BASE,
                  SEGMENT_INACTIVE,
                  "bg-transparent border-0 p-0 m-0 truncate max-w-[16rem]",
                )}
                title={segment.title ?? segment.label}
              >
                {segment.label}
              </button>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
};

export default SyncFolderBreadcrumb;
