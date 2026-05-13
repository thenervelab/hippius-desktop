"use client";

import { FC } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface SyncFolderBreadcrumbProps {
  /** Active folder display name. When null, only the "Local" segment renders. */
  folderDisplayName: string | null;
  /** Click handler for the "Local" segment — switches drive to the cards view. */
  onLocalClick: () => void;
  /** Optional overrides for the outer nav — used when embedding inline with action buttons. */
  className?: string;
}

const SEGMENT_BASE = cn(
  "font-geist text-[14px] font-medium leading-normal tracking-[-0.28px]",
  "whitespace-nowrap",
);

// Inactive ("Local" when a folder is open): muted to 40% opacity per Figma.
const SEGMENT_INACTIVE = cn(
  "text-black-700 dark:text-grey-light-200 opacity-40",
  "hover:opacity-100 transition-opacity cursor-pointer",
);

// Active (current): full opacity per Figma.
const SEGMENT_ACTIVE = "text-black-700 dark:text-grey-light-200";

const SyncFolderBreadcrumb: FC<SyncFolderBreadcrumbProps> = ({
  folderDisplayName,
  onLocalClick,
  className,
}) => {
  const isOnFolder = folderDisplayName !== null && folderDisplayName !== "";

  return (
    <nav
      aria-label="Sync folder breadcrumb"
      className={cn(
        "flex items-center gap-1 mt-6 mb-5 select-none",
        className,
      )}
    >
      <button
        type="button"
        onClick={onLocalClick}
        // When already on Local view there's nothing to navigate to, but we
        // still keep the button enabled so the click target stays consistent
        // across views — the parent simply re-renders the same view.
        className={cn(
          SEGMENT_BASE,
          isOnFolder ? SEGMENT_INACTIVE : SEGMENT_ACTIVE,
          "bg-transparent border-0 p-0 m-0",
        )}
      >
        Local
      </button>
      {isOnFolder && (
        <>
          <ChevronRight
            aria-hidden
            className="size-[14px] text-black-700 dark:text-grey-light-200 opacity-40"
          />
          <span
            className={cn(SEGMENT_BASE, SEGMENT_ACTIVE, "truncate max-w-[20rem]")}
            title={folderDisplayName ?? undefined}
          >
            {folderDisplayName}
          </span>
        </>
      )}
    </nav>
  );
};

export default SyncFolderBreadcrumb;
