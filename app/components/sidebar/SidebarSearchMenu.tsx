"use client";

import { FC } from "react";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getFileIcon } from "@/lib/utils/fileTypeUtils";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import cn from "@/app/lib/utils/cn";
import Skeleton from "@/components/ui/skeleton";
import {
  NoEntriesIllustration,
  NoEntriesIllustrationDark,
} from "@/components/ui/icons";

interface SidebarSearchMenuProps {
  files: FormattedUserFile[];
  isFetching: boolean;
  searchTerm: string;
  onSelect: (file: FormattedUserFile) => void;
}

const MAX_LIST_HEIGHT_PX = 360;
const SKELETON_ROW_COUNT = 6;

// Skeleton bar styling mirrors `FilesTableSkeleton` so the sidebar
// search loading state visually rhymes with the main files table.
const SKELETON_BAR_CLASS =
  "rounded-full bg-grey-80 dark:bg-black-300 animate-pulse";

const SkeletonRow: FC<{ index: number }> = ({ index }) => (
  <div
    className={cn(
      "flex w-full items-center gap-2 px-2 py-[8px]",
      index % 2 === 0
        ? "bg-grey-light-200 dark:bg-black-500"
        : "bg-grey-light-400 dark:bg-black-primary-bg",
    )}
  >
    <Skeleton
      variant="rectangle"
      width="16px"
      height="16px"
      className={cn(SKELETON_BAR_CLASS, "!rounded-[4px]")}
    />
    <div className="min-w-0 flex-1">
      <Skeleton
        height="0.75rem"
        width={`${55 + ((index * 7) % 35)}%`}
        className={SKELETON_BAR_CLASS}
      />
    </div>
    <div className="w-[80px] flex justify-end">
      <Skeleton height="0.75rem" width="50%" className={SKELETON_BAR_CLASS} />
    </div>
  </div>
);

const SidebarSearchMenu: FC<SidebarSearchMenuProps> = ({
  files,
  isFetching,
  searchTerm,
  onSelect,
}) => {
  const trimmed = searchTerm.trim();
  const hasQuery = trimmed.length > 0;
  const showEmpty = hasQuery && !isFetching && files.length === 0;
  const showSkeleton = hasQuery && isFetching && files.length === 0;

  return (
    <div
      aria-label="File search results"
      className={cn(
        "w-[320px] overflow-hidden rounded-[8px] border bg-grey-light-300",
        "border-grey-dark-100 shadow-[0px_5px_5.5px_0px_rgba(0,0,0,0.17),0px_20px_10px_0px_rgba(0,0,0,0.14),0px_45px_13.5px_0px_rgba(0,0,0,0.08)]",
        "dark:border-black-300 dark:bg-black-600 dark:shadow-[0_12px_36px_rgba(0,0,0,0.5)]",
      )}
    >
      <div
        className="flex flex-col overflow-y-auto"
        style={{ maxHeight: MAX_LIST_HEIGHT_PX }}
      >
        {showSkeleton &&
          Array.from({ length: SKELETON_ROW_COUNT }).map((_, index) => (
            <SkeletonRow key={`sidebar-search-skel-${index}`} index={index} />
          ))}
        {showEmpty && (
          // Compact inline empty state. The shared `NoEntriesFound`
          // wraps its content in `NoEntriesBackgroundContainer`, whose
          // nested decorative cards + graphsheet textures collapse
          // badly inside a 320px dropdown — see the dogfood screenshot
          // that prompted this. Here we render the same intent
          // (illustration + title + description) in the horizontal
          // layout the drive's `NoMatchingResults` uses, but sized for
          // the dropdown.
          <div className="flex items-center gap-3 px-3 py-4">
            <div className="shrink-0 overflow-hidden">
              <NoEntriesIllustration className="block dark:hidden size-12" />
              <NoEntriesIllustrationDark className="hidden dark:block size-12" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-[13px] font-medium leading-[18px] tracking-[-0.26px] text-[#171717] dark:text-white">
                No matching results
              </h3>
              <p className="mt-[2px] text-[12px] font-medium leading-[16px] tracking-[-0.24px] text-[#52525c] dark:text-white/50">
                No files found matching &quot;{trimmed}&quot;. Try a different
                search term.
              </p>
            </div>
          </div>
        )}
        {files.map((file, index) => {
          const { fileFormat } = getFilePartsFromFileName(file.name);
          const fileType = getFileTypeFromExtension(fileFormat || null);
          const { icon: Icon, color } = getFileIcon(
            fileType || "document",
            false,
          );
          const sizeText =
            typeof file.size === "number" && file.size > 0
              ? formatBytes(file.size, 2)
              : "—";
          const rowKey = `${file.label ?? ""}::${
            file.actualFileName ?? file.name
          }`;
          return (
            <button
              key={rowKey}
              type="button"
              onClick={() => onSelect(file)}
              className={cn(
                "flex w-full items-center gap-0 text-left transition-colors",
                // Row separator matches the column rules in the Figma
                // — a hairline between every row, fading out for the
                // last one so the bottom of the panel sits clean
                // against the wrapper's rounded corner.
                "border-b border-grey-dark-100 last:border-b-0 dark:border-black-300",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-50/40 focus-visible:ring-inset",
                index % 2 === 0
                  ? "bg-grey-light-200 dark:bg-black-500"
                  : "bg-grey-light-400 dark:bg-black-primary-bg",
                "hover:bg-grey-light-700 dark:hover:bg-black-300",
              )}
            >
              {/* Name cell — also carries the vertical divider that
                  separates Name from Size in the Figma. */}
              <span className="flex min-w-0 flex-1 items-center gap-2 border-r border-grey-dark-100 px-2 py-[5px] dark:border-black-300">
                <Icon className={cn("size-4 flex-shrink-0", color)} />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium tracking-[-0.24px] text-[#1d1d1d] dark:text-grey-light-100">
                  {file.name}
                </span>
              </span>
              <span className="flex-shrink-0 w-[80px] px-2 py-[5px] text-right text-[12px] font-medium tracking-[-0.24px] text-grey-dark-800 dark:text-grey-50">
                {sizeText}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default SidebarSearchMenu;
