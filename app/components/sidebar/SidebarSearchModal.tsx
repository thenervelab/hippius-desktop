"use client";

import {
  FC,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import cn from "@/app/lib/utils/cn";
import { Icons } from "@/components/ui";
import SearchShortcutHint from "./SearchShortcutHint";
import Skeleton from "@/components/ui/skeleton";
import {
  NoEntriesIllustration,
  NoEntriesIllustrationDark,
} from "@/components/ui/icons";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { useGlobalRecursiveFileSearch } from "@/app/lib/hooks/useGlobalRecursiveFileSearch";
import useRecentUploads from "@/app/lib/hooks/useRecentUploads";
import { getFileIcon } from "@/lib/utils/fileTypeUtils";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { formatUploadedDate } from "@/app/lib/utils/formatUploadedDate";
import { getSidebarSearchView } from "./sidebarSearchState";

// The palette is a screen-centered overlay (ClickUp-style command bar)
// portalled to <body>, so the sidebar's `overflow-hidden` can't clip it and
// it floats above every page surface. The component is only mounted while
// the palette is open, so the recent-uploads fetch is lazy (it fires on
// first open, then react-query caches it alongside the home page's copy).
interface SidebarSearchModalProps {
  /** Close the palette (Esc, overlay click, or after selecting a file). */
  onClose: () => void;
  /** Owner account used by the cross-drive search IPC. */
  accountId: string | null | undefined;
  /** Drive labels to fan the search across. */
  labels: string[];
  /**
   * Open a file. Receives the file plus the list it was chosen from so the
   * preview dialog's prev/next navigation walks the same set the user saw
   * (recent uploads or search results).
   */
  onSelect: (file: FormattedUserFile, list: FormattedUserFile[]) => void;
}

/** "Last uploads" count shown on an empty query — matches the console's limit. */
const RECENT_LIMIT = 7;
const SKELETON_ROW_COUNT = 7;
const LIST_MAX_HEIGHT_PX = 420;

// Skeleton bar styling rhymes with `FilesTableSkeleton` / the old dropdown.
const SKELETON_BAR_CLASS =
  "rounded-full bg-grey-80 dark:bg-black-300 animate-pulse";

const SkeletonRow: FC<{ index: number }> = ({ index }) => (
  <div className="flex w-full items-center gap-3 px-4 py-2">
    <Skeleton
      variant="rectangle"
      width="20px"
      height="20px"
      className={cn(SKELETON_BAR_CLASS, "!rounded-[6px]")}
    />
    {/* Two stacked bars mirror the name + size-subtitle layout of a real row. */}
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <Skeleton
        height="0.8rem"
        width={`${50 + ((index * 7) % 35)}%`}
        className={SKELETON_BAR_CLASS}
      />
      <Skeleton height="0.7rem" width="32%" className={SKELETON_BAR_CLASS} />
    </div>
    <Skeleton height="0.75rem" width="52px" className={SKELETON_BAR_CLASS} />
  </div>
);

// Compact illustration + copy used for both empty states. The shared
// `NoEntriesFound` wraps itself in decorative cards that collapse badly in a
// narrow panel, so we render the same intent inline (mirrors the old
// dropdown's empty state, scaled up for the wider modal).
const EmptyState: FC<{ title: string; description: string }> = ({
  title,
  description,
}) => (
  <div className="flex items-center gap-3 px-4 py-6">
    <div className="shrink-0 overflow-hidden">
      <NoEntriesIllustration className="block dark:hidden size-14" />
      <NoEntriesIllustrationDark className="hidden dark:block size-14" />
    </div>
    <div className="flex-1 min-w-0">
      <h3 className="text-[14px] font-medium leading-5 tracking-[-0.28px] text-[#171717] dark:text-white">
        {title}
      </h3>
      <p className="mt-[2px] text-[13px] font-medium leading-[18px] tracking-[-0.26px] text-[#52525c] dark:text-white/50">
        {description}
      </p>
    </div>
  </div>
);

const SidebarSearchModal: FC<SidebarSearchModalProps> = ({
  onClose,
  accountId,
  labels,
  onSelect,
}) => {
  const [value, setValue] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // Mount → "shown" on the next frame drives the open transition.
  const [shown, setShown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const trimmed = value.trim();
  const hasQuery = trimmed.length > 0;

  const { data: results, isFetching } = useGlobalRecursiveFileSearch({
    accountId,
    labels,
    criteria: { searchTerm: value },
    enabled: hasQuery,
  });

  // "Last uploads" — account-wide recent uploads from the HCFS server's
  // /search_files endpoint (sorted newest-first server-side), the same source
  // the web console's "Last Uploads" uses. The slice is a belt-and-suspenders
  // cap; the server already limits to RECENT_LIMIT.
  const { data: recentData, isLoading: recentLoading } =
    useRecentUploads(RECENT_LIMIT);
  const recentFiles = useMemo(
    () => (recentData ?? []).slice(0, RECENT_LIMIT),
    [recentData],
  );

  const view = getSidebarSearchView({
    hasQuery,
    isFetching,
    resultCount: results.length,
    recentLoading,
    recentCount: recentFiles.length,
  });

  // Only the row-bearing views feed keyboard navigation / Enter selection;
  // skeleton and empty views expose no rows to land on. Memoised so the
  // selection callbacks below keep a stable identity across renders.
  const visibleFiles = useMemo(
    () => (view === "results" ? results : view === "recent" ? recentFiles : []),
    [view, results, recentFiles],
  );
  const clampedActive = Math.min(
    activeIndex,
    Math.max(0, visibleFiles.length - 1),
  );

  // Entrance transition + body scroll lock + Esc handling, scoped to the
  // palette's lifetime (it unmounts on close).
  useEffect(() => {
    setShown(true);
    inputRef.current?.focus();

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  // Reset the highlight whenever the query changes (the list underneath it
  // changes too). Clamping above keeps it valid as a list shrinks.
  useEffect(() => setActiveIndex(0), [value]);

  // Keep the highlighted row scrolled into view as arrow keys move it.
  useEffect(() => {
    rowRefs.current[clampedActive]?.scrollIntoView({ block: "nearest" });
  }, [clampedActive]);

  const handleSelect = useCallback(
    (file: FormattedUserFile) => onSelect(file, visibleFiles),
    [onSelect, visibleFiles],
  );

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, visibleFiles.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const file = visibleFiles[clampedActive];
        if (file) handleSelect(file);
      }
    },
    [visibleFiles, clampedActive, handleSelect],
  );

  const showRecentHeader =
    view === "recent" || view === "recent-loading" || view === "recent-empty";

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="presentation"
      onMouseDown={(event) => {
        // Close only on a true overlay click — clicks inside the panel
        // stopPropagation below, so they never reach here.
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        "fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh]",
        "bg-black/40 backdrop-blur-[2px] transition-opacity duration-150 dark:bg-black/70",
        shown ? "opacity-100" : "opacity-0",
      )}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search files"
        onMouseDown={(event) => event.stopPropagation()}
        className={cn(
          "flex w-full max-w-[640px] flex-col overflow-hidden rounded-[14px] border",
          "border-grey-dark-100 bg-grey-light-300 shadow-[0px_5px_5.5px_0px_rgba(0,0,0,0.17),0px_20px_10px_0px_rgba(0,0,0,0.14),0px_45px_13.5px_0px_rgba(0,0,0,0.08)]",
          "dark:border-black-300 dark:bg-black-600 dark:shadow-[0_24px_60px_rgba(0,0,0,0.55)]",
          "transition-[opacity,transform] duration-150",
          shown ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1",
        )}
      >
        {/* Search field */}
        <div className="flex items-center gap-3 border-b border-grey-dark-100 px-4 py-[14px] dark:border-black-300">
          <Icons.Search className="size-[18px] flex-shrink-0 text-[#1111114D] dark:text-white/30" />
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Search Files"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 outline-none text-[15px] leading-6 font-medium text-black placeholder:text-[#1111114D] dark:text-white dark:placeholder:text-white/30"
          />
          {hasQuery ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setValue("");
                inputRef.current?.focus();
              }}
              className={cn(
                "flex items-center justify-center rounded-md px-1.5 py-0.5",
                "text-[#1111114D] transition-colors hover:text-[#11111180] dark:text-white/30 dark:hover:text-white/70",
              )}
            >
              <Icons.Close className="size-4" />
            </button>
          ) : (
            <SearchShortcutHint />
          )}
        </div>

        {/* Results / recent uploads */}
        <div
          className="flex flex-col overflow-y-auto py-1"
          style={{ maxHeight: LIST_MAX_HEIGHT_PX }}
        >
          {showRecentHeader && (
            <div className="flex items-center gap-1.5 px-4 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#7a7a85] dark:text-white/40">
              <Icons.Clock className="size-3.5" />
              <span>Last uploads</span>
            </div>
          )}

          {(view === "skeleton" || view === "recent-loading") &&
            Array.from({ length: SKELETON_ROW_COUNT }).map((_, index) => (
              <SkeletonRow key={`sidebar-search-skel-${index}`} index={index} />
            ))}

          {view === "no-results" && (
            <EmptyState
              title="No matching results"
              description={`No files found matching "${trimmed}". Try a different search term.`}
            />
          )}

          {view === "recent-empty" && (
            <EmptyState
              title="No uploads yet"
              description="Files you upload will show up here for quick access."
            />
          )}

          {(view === "results" || view === "recent") &&
            visibleFiles.map((file, index) => {
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
              const uploadedText = formatUploadedDate(file.createdAt);
              const rowKey = `${file.label ?? ""}::${
                file.actualFileName ?? file.name
              }`;
              return (
                <button
                  key={rowKey}
                  ref={(el) => {
                    rowRefs.current[index] = el;
                  }}
                  type="button"
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => handleSelect(file)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2 text-left transition-colors",
                    "focus-visible:outline-none",
                    index === clampedActive
                      ? "bg-grey-light-200 dark:bg-black-500"
                      : "bg-transparent",
                  )}
                >
                  <Icon className={cn("size-5 flex-shrink-0", color)} />
                  {/* Name on top, file size as a muted subtitle below it. */}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[14px] font-medium leading-5 tracking-[-0.28px] text-[#1d1d1d] dark:text-grey-light-100">
                      {file.name}
                    </span>
                    <span className="truncate text-[12px] font-medium leading-4 tracking-[-0.24px] text-grey-dark-800 dark:text-grey-50">
                      {sizeText}
                    </span>
                  </span>
                  {/* Uploaded date replaces the old right-aligned size cell. */}
                  {uploadedText && (
                    <span className="flex-shrink-0 whitespace-nowrap text-[12px] font-medium tracking-[-0.24px] text-grey-dark-800 dark:text-grey-50">
                      {uploadedText}
                    </span>
                  )}
                </button>
              );
            })}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default SidebarSearchModal;
