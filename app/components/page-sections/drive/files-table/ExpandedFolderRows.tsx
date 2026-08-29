"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, ChevronRight, MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormattedTimestamp } from "@/app/components/ui";
import { cn } from "@/lib/utils";
import { formatBytesFromBigInt } from "@/lib/utils/formatBytes";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import {
  getFileTypeDisplayLabel,
  getFileTypeFromExtension,
} from "@/lib/utils/getTileTypeFromExtension";
import { useRouter } from "next/navigation";
import { useInfiniteScroll } from "@/lib/hooks/use-infinite-scroll";
import { useNestedFolderListing } from "@/app/lib/hooks/use-nested-folder-listing";
import { FILES_MUTATED_EVENT } from "@/app/lib/utils/fileMutationEvents";
import { useFileSelection } from "@/app/contexts/FileSelectionContext";
import { useFolderAggregateSelection } from "@/app/lib/hooks/use-folder-aggregate-selection";
import TableActionMenu, {
  type ActionItem,
} from "@/app/components/ui/alt-table/TableActionMenu";
import FileCheckbox from "./FileCheckbox";
import NameCell from "./NameCell";
import { PreviewTrigger } from "@/app/components/page-sections/drive/file-preview";
import { isPreviewableFileName } from "@/app/lib/utils/filePreviewType";
import { FolderRowsSkeleton } from "./FilesTableSkeleton";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { preserveClosestScrollPosition } from "./preserveClosestScrollPosition";

const TIME_BEFORE_ERR = 30 * 60 * 1000;
const MAX_INLINE_DEPTH = 8;
// Minimum time the inner-folder skeleton stays visible. Cached listings can
// resolve in <50ms, which produces a jarring flash; clamping to this lower
// bound makes the expand feel intentional. Tweak as needed.
const MIN_SKELETON_DURATION_MS = 200;
// Child rows need to align against the parent row's existing name-cell
// layout: 8px left padding, then a 20px icon, then an 8px gap before
// the label. That means:
// - a depth-0 child chevron should start at the same x-position as the
//   parent icon
// - a depth-0 child file/folder icon should start at the same
//   x-position as the parent text
// Each deeper level repeats that same 28px step (20px chevron slot +
// 8px gap).
const BASE_CHILD_INDENT_PX = 8;
const DEPTH_INDENT_PX = 28;

// Cell classes mirror the parent <TableModule.Td> override applied in
// files-table/index.tsx so vertical borders, padding, font weight, and
// text colour all match the parent header across both themes.
const BASE_CELL_CLASS =
  "font-medium px-2 py-[5px] border-r last:border-r-0 border-grey-dark-100 text-grey-dark-800 text-xs dark:border-black-300 overflow-hidden";

const resolveRelativePath = (basePath: string, entryName: string) => {
  const normalizedName = entryName.replace(/^\/+|\/+$/g, "");
  if (!basePath) return normalizedName;
  if (
    normalizedName === basePath ||
    normalizedName.startsWith(`${basePath}/`)
  ) {
    return normalizedName;
  }
  if (normalizedName.includes("/")) return normalizedName;
  return `${basePath}/${normalizedName}`;
};

export interface ExpandedFolderRowsProps {
  folder: FormattedUserFile;
  accountId: string | null | undefined;
  syncPath: string | null | undefined;
  label?: string;
  baseSubfolderPath?: string | null;
  depth?: number;
  /** Canonical column order — used to decide which leading rail cells
   *  to render so the row lines up with the outer table's colgroup. */
  orderedColumnIds: string[];
  createTableItems: (
    file: FormattedUserFile,
    fileType: string | null,
    arionHash: string,
    canPreview?: boolean,
    folderExpansion?: { expanded: boolean; onToggle: () => void },
    parentSubFolderPath?: string,
    previewSiblings?: FormattedUserFile[],
  ) => ActionItem[];
  /** `previewSiblings` is this folder's full (sorted) listing — the viewer
   *  scopes its thumbnail rail and prev/next to it, so opening a file from
   *  an expanded subtree navigates within that folder, not within the
   *  page's top-level rows. */
  onSelectFile: (
    file: FormattedUserFile,
    previewSiblings?: FormattedUserFile[],
  ) => void;
  onRowContextMenu?: (
    event: React.MouseEvent,
    file: FormattedUserFile,
    previewSiblings?: FormattedUserFile[],
  ) => void;
  /** Invoked when a folder click should escape inline expansion and
   *  navigate via the URL (depth overflow, or future opt-outs). The
   *  second arg is the parent folder's path inside the sync drive so
   *  callers can build the correct deep-link URL — the previous
   *  signature dropped this and produced URLs missing intermediate
   *  segments. */
  onOpenFolder?: (
    folder: FormattedUserFile,
    parentSubFolderPath: string,
  ) => void;
  sortBy?: "name" | "size" | "date_uploaded";
  sortDir?: "asc" | "desc";
  /**
   * Chain of folder rows that are currently selected and lie strictly
   * above this rendering context. When non-empty, every visible row at
   * this depth visually cascades-selected (the topmost ancestor is
   * checked, so the user "sees" the selection flow downward). The
   * parent passes its own row appended when it is itself selected.
   */
  ancestorChain?: FormattedUserFile[];
  /**
   * Bridge to FilesTable's deletion tracker. Same shape as the
   * `isItemDeleting` helper there — accepts the row and its parent
   * relative path, returns true while the delete IPC is in flight.
   */
  isItemDeleting?: (file: FormattedUserFile, parentPath: string) => boolean;
}

/**
 * Holds `showSkeleton` true for at least `minDurationMs` once a load
 * starts, even when the upstream `isLoading` flips back to false sooner
 * (cached react-query hits, in-memory listings, etc.). Returns the
 * delayed flag the caller should render against.
 *
 * If the real load takes longer than `minDurationMs`, the flag tracks
 * `isLoading` directly — the minimum is a floor, not a fixed duration.
 */
const useMinimumLoadingTime = (
  isLoading: boolean,
  minDurationMs: number,
): boolean => {
  const [showSkeleton, setShowSkeleton] = useState(isLoading);
  const startedAtRef = useRef<number | null>(
    isLoading ? performance.now() : null,
  );

  useEffect(() => {
    if (isLoading) {
      // Re-entering the loading state — reset the floor timer.
      startedAtRef.current = performance.now();
      setShowSkeleton(true);
      return;
    }

    const startedAt = startedAtRef.current;
    if (startedAt == null) {
      setShowSkeleton(false);
      return;
    }

    const elapsed = performance.now() - startedAt;
    if (elapsed >= minDurationMs) {
      startedAtRef.current = null;
      setShowSkeleton(false);
      return;
    }

    const remaining = minDurationMs - elapsed;
    const timeout = setTimeout(() => {
      startedAtRef.current = null;
      setShowSkeleton(false);
    }, remaining);
    return () => clearTimeout(timeout);
  }, [isLoading, minDurationMs]);

  return showSkeleton;
};

/**
 * Renders the contents of an expanded folder as a flat sequence of
 * `<tr>` elements **directly inside the outer table's `<tbody>`**.
 *
 * Why no inner `<table>`? Nesting tables (even with matching `<colgroup>`
 * percentages) leaves each level computing its own column widths
 * against its own container width, and sub-pixel rounding drifts
 * progressively with depth. Rendering child rows as direct siblings of
 * the parent row in the same table means the browser's table-layout
 * algorithm sizes every cell against the same `<colgroup>`, so vertical
 * column borders line up exactly regardless of nesting depth.
 *
 * Nested expansion recurses into this same component, again returning
 * a flat `<>{rows}</>` so the recursion never re-introduces a nested
 * `<table>`.
 */
const ExpandedFolderRows: React.FC<ExpandedFolderRowsProps> = ({
  folder,
  accountId,
  syncPath,
  label,
  baseSubfolderPath = "",
  depth = 0,
  orderedColumnIds,
  createTableItems,
  onSelectFile,
  onRowContextMenu,
  onOpenFolder,
  sortBy,
  sortDir,
  ancestorChain = [],
  isItemDeleting,
}) => {
  const router = useRouter();
  const {
    isSelectionMode,
    toggleFileSelection,
    toggleFolderSelection,
    removeFileFromSelection,
    addFilesToSelection,
  } = useFileSelection();
  const {
    isVisuallySelected,
    classifyVisualSelection,
    clearAggregateSelection,
  } = useFolderAggregateSelection();
  const [expandedSubfolders, setExpandedSubfolders] = useState<
    Record<string, boolean>
  >({});

  const folderRelativePath = useMemo(() => {
    const name = folder.actualFileName || folder.name;
    return resolveRelativePath(baseSubfolderPath ?? "", name);
  }, [baseSubfolderPath, folder.actualFileName, folder.name]);

  const listingEnabled = Boolean(
    accountId && syncPath && label && folderRelativePath,
  );

  // Background-refresh the child rows when a sync cycle lands or an in-app
  // mutation (rename) changes names instantly — same pair of triggers as
  // DriveContainer's nested view. Without this, a row renamed inside an
  // open accordion kept its old name until collapse/re-expand.
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    const bump = () => setRefreshKey((prev) => prev + 1);
    window.addEventListener("sync_files_completed_changed", bump);
    window.addEventListener(FILES_MUTATED_EVENT, bump);
    return () => {
      window.removeEventListener("sync_files_completed_changed", bump);
      window.removeEventListener(FILES_MUTATED_EVENT, bump);
    };
  }, []);

  const { data, isLoading } = useNestedFolderListing({
    accountId,
    syncPath,
    subfolder: listingEnabled ? folderRelativePath : null,
    label: label ?? null,
    refreshKey,
    enabled: listingEnabled,
  });

  const showLoadingSkeleton = useMinimumLoadingTime(
    isLoading,
    MIN_SKELETON_DURATION_MS,
  );

  const sortedChildRows = useMemo(() => {
    if (!sortBy) return data;
    const direction = sortDir === "asc" ? 1 : -1;
    return [...data].sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      if (sortBy === "name") {
        return (a.name || "").localeCompare(b.name || "") * direction;
      }
      if (sortBy === "size") {
        return ((a.size ?? 0) - (b.size ?? 0)) * direction;
      }
      return (a.createdAt - b.createdAt) * direction;
    });
  }, [data, sortBy, sortDir]);

  const { visibleData, hasMore, loadMore } = useInfiniteScroll(
    sortedChildRows,
    (f) => `${f.label ?? ""}::${f.actualFileName ?? f.arionHash}::${f.lastChargedAt}`
  );
  const sentinelRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    if (!hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: "200px", threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  useEffect(() => {
    setExpandedSubfolders({});
  }, [folderRelativePath]);

  const columnCount = orderedColumnIds.length;
  const hasSelectionColumn = orderedColumnIds.includes("selection");

  // Match the console tree layout: start from the same left padding as
  // the parent name cell, then add one chevron-slot step per nested
  // level so child chevrons align with parent icons and child icons
  // align with parent text.
  const depthIndentStyle = useMemo(
    () => ({
      paddingLeft: `${BASE_CHILD_INDENT_PX + (depth + 1) * DEPTH_INDENT_PX}px`,
    }),
    [depth],
  );

  const handleToggleSubfolder = useCallback(
    (childFile: FormattedUserFile, childPath: string) => {
      if (depth >= MAX_INLINE_DEPTH) {
        onOpenFolder?.(childFile, folderRelativePath);
        return;
      }
      setExpandedSubfolders((previous) => ({
        ...previous,
        [childPath]: !previous[childPath],
      }));
    },
    [depth, onOpenFolder, folderRelativePath],
  );

  const renderLeadingRailCells = (key: string) => (
    <>
      {hasSelectionColumn ? (
        <td
          key={`${key}-selection`}
          className={cn(BASE_CELL_CLASS, "px-0 py-0 text-center")}
        />
      ) : null}
    </>
  );

  // Single-row placeholder states (listing unavailable / folder empty).
  // The message goes in the NAME cell — indented to this folder's child
  // depth (so it lines up with where contents would render) — and the
  // remaining columns are rendered as real empty `BASE_CELL_CLASS` cells.
  // Using per-column cells instead of one `colSpan` cell keeps the vertical
  // column borders aligned with every other row; a colSpan merges them and
  // the separators disappear for the placeholder row. The w-5 spacer mirrors
  // the child row's chevron slot so the text aligns with sibling names.
  const renderMessageRow = (key: string, message: string) => {
    // Trailing cells = all columns minus the selection rail minus the name
    // cell, matching the size/date/type/actions a normal child row renders.
    const trailingCellCount = Math.max(
      columnCount - (hasSelectionColumn ? 1 : 0) - 1,
      0,
    );
    return (
      <tr
        className={cn(
          // Same zebra striping (and border) a data row uses, so the
          // placeholder keeps the odd/even alternation instead of painting
          // a fixed colour that breaks the pattern. nth-child counts all
          // flat <tr> siblings in the shared tbody, so this lands on the
          // correct stripe for its position.
          "border-b-0 odd:bg-grey-light-200 even:bg-grey-light-400 dark:odd:bg-black-500 dark:even:bg-black-primary-bg",
        )}
      >
        {renderLeadingRailCells(key)}
        <td className={cn(BASE_CELL_CLASS, "p-0 relative")}>
          <div
            className="flex items-center min-w-0 gap-2 py-[5px] pr-2 text-grey-60"
            style={depthIndentStyle}
          >
            <span className="w-5 shrink-0" aria-hidden />
            <span>{message}</span>
          </div>
        </td>
        {Array.from({ length: trailingCellCount }).map((_, i) => (
          <td key={`${key}-fill-${i}`} className={BASE_CELL_CLASS} />
        ))}
      </tr>
    );
  };

  if (!listingEnabled) {
    return renderMessageRow("unavailable", "Folder listing is unavailable.");
  }

  if (showLoadingSkeleton) {
    return (
      <FolderRowsSkeleton
        orderedColumnIds={orderedColumnIds}
        nameIndentPx={BASE_CHILD_INDENT_PX + (depth + 1) * DEPTH_INDENT_PX}
      />
    );
  }

  if (!visibleData.length) {
    return renderMessageRow("empty", "Folder is empty.");
  }

  return (
    <>
      {visibleData.map((childFile) => {
        const rowState: "success" | "pending" | "error" = childFile.tempData
          ? Date.now() - childFile.tempData.uploadTime > TIME_BEFORE_ERR
            ? "error"
            : "pending"
          : "success";

        const { fileFormat } = getFilePartsFromFileName(childFile.name);
        const fileType = getFileTypeFromExtension(fileFormat || null);
        // Annotate child row with its parent path so all selection /
        // deletion keys downstream are unambiguous.
        const annotatedChild: FormattedUserFile = {
          ...childFile,
          parentRelativePath: childFile.isFolder
            ? folderRelativePath
            : childFile.parentRelativePath,
        };
        const isDeleting = Boolean(
          isItemDeleting?.(childFile, folderRelativePath),
        );
        const isSelected = isVisuallySelected(annotatedChild, ancestorChain);
        const canSelect = childFile.isAssigned && !isDeleting;
        const isChildFolder = Boolean(childFile.isFolder);
        const childRelativePath = resolveRelativePath(
          folderRelativePath,
          childFile.actualFileName || childFile.name,
        );
        const isSubfolderExpanded =
          isChildFolder && Boolean(expandedSubfolders[childRelativePath]);

        // Cascade-aware toggle for nested rows. Same branching as the
        // top-level handler in FilesTable: cascade → split ancestor
        // into visible siblings; direct → remove (and wipe leaves on
        // folder deselect); none → fresh add via folder-or-file path.
        const handleToggleChild = () => {
          const kind = classifyVisualSelection(annotatedChild, ancestorChain);
          if (kind === "cascade" && ancestorChain.length > 0) {
            const topAncestor = ancestorChain[0];
            removeFileFromSelection(topAncestor);
            const siblings = visibleData
              .filter(
                (other) =>
                  (other.actualFileName ?? other.name) !==
                  (childFile.actualFileName ?? childFile.name),
              )
              .map((other) => ({
                ...other,
                parentRelativePath: other.isFolder
                  ? folderRelativePath
                  : other.parentRelativePath,
              }));
            addFilesToSelection(siblings);
            return;
          }
          if (kind === "direct") {
            removeFileFromSelection(annotatedChild);
            if (annotatedChild.isFolder) {
              clearAggregateSelection(annotatedChild);
            }
            return;
          }
          if (annotatedChild.isFolder) {
            clearAggregateSelection(annotatedChild);
            toggleFolderSelection(annotatedChild);
          } else {
            toggleFileSelection(annotatedChild);
          }
        };

        const nameNode = (
          <NameCell
            rawName={childFile.name}
            actualName={childFile.actualFileName}
            label={childFile.label}
            arionHash={childFile.arionHash}
            isAssigned={childFile.isAssigned}
            fileType={fileType || "document"}
            isPreviewable={!isSelectionMode}
            isFolder={childFile.isFolder}
            source={childFile.source}
            mainReqHash={childFile.mainReqHash}
            syncStatus={childFile.syncStatus}
            parentSubFolderPath={folderRelativePath}
            onManageShare={() => router.push("/shares")}
          />
        );

        // `sortedChildRows` is this folder's full listing: passing it keeps the
        // viewer's rail and prev/next scoped to the folder the file lives in
        // rather than the page's top-level rows.
        const nameContent =
          !isSelectionMode &&
          !childFile.isFolder &&
          isPreviewableFileName(childFile.name) ? (
            <PreviewTrigger
              onClick={() => onSelectFile(childFile, sortedChildRows)}
              className="min-w-0 px-0 py-0"
            >
              {nameNode}
            </PreviewTrigger>
          ) : (
            nameNode
          );

        const actionItems = createTableItems(
          childFile,
          fileType,
          childFile.arionHash,
          true,
          undefined,
          folderRelativePath,
          sortedChildRows,
        );

        return (
          <React.Fragment
            key={`${folderRelativePath}-${childRelativePath}-${childFile.name}`}
          >
            <tr
              className={cn(
                "border-b-0 odd:bg-grey-light-200 even:bg-grey-light-400 hover:bg-grey-light-300 dark:odd:bg-black-500 dark:even:bg-black-primary-bg dark:hover:bg-black-300",
                rowState === "pending" && "animate-pulse",
                rowState === "error" && "bg-red-200/20",
                isDeleting &&
                  "opacity-50 cursor-not-allowed pointer-events-none",
                isSelectionMode && canSelect && "cursor-pointer",
                isSelectionMode &&
                  isSelected &&
                  canSelect &&
                  "bg-primary-60/10",
                isSelectionMode &&
                  !isSelected &&
                  canSelect &&
                  "hover:bg-primary-60/8",
                isSelectionMode &&
                  !canSelect &&
                  "opacity-50 cursor-not-allowed",
              )}
              onContextMenu={(event) => {
                if (isDeleting) return;
                // `annotatedChild`, not `childFile`: the context menu's share
                // and delete handlers resolve a folder row's path from
                // `parentRelativePath`, and the raw row carries only a
                // basename — which would target a same-named folder at the
                // drive root.
                onRowContextMenu?.(event, annotatedChild, sortedChildRows);
              }}
              onClick={(event) => {
                if (isDeleting) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                const target = event.target as HTMLElement;
                if (
                  target.closest(".action-menu-area") ||
                  target.closest('[role="checkbox"]') ||
                  target.closest(".checkbox-container") ||
                  target.closest(".folder-expander-area")
                ) {
                  return;
                }

                if (isSelectionMode && canSelect) {
                  event.preventDefault();
                  event.stopPropagation();
                  preserveClosestScrollPosition(target, handleToggleChild);
                }
              }}
            >
              {hasSelectionColumn ? (
                <td
                  className={cn(BASE_CELL_CLASS, "px-2 py-[5px] text-center")}
                >
                  <div className="flex justify-center checkbox-container">
                    <FileCheckbox
                      selected={isSelected}
                      onChange={handleToggleChild}
                      disabled={!canSelect}
                    />
                  </div>
                </td>
              ) : null}
              <td className={cn(BASE_CELL_CLASS, "p-0 relative")}>
                <div
                  className="flex items-center min-w-0 gap-2 py-[5px] pr-2"
                  style={depthIndentStyle}
                >
                  <div className="flex w-5 shrink-0 items-center justify-center">
                    {isChildFolder ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          preserveClosestScrollPosition(
                            event.currentTarget,
                            () =>
                              handleToggleSubfolder(
                                childFile,
                                childRelativePath,
                              ),
                          );
                        }}
                        className="folder-expander-area flex size-5 items-center justify-center rounded text-grey-60 transition-colors hover:text-grey-20 dark:text-grey-dark-700 dark:hover:text-grey-dark-200"
                        aria-label={
                          isSubfolderExpanded
                            ? "Collapse folder"
                            : "Expand folder"
                        }
                      >
                        {isSubfolderExpanded ? (
                          <ChevronDown className="size-3.5" />
                        ) : (
                          <ChevronRight className="size-3.5" />
                        )}
                      </button>
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">{nameContent}</div>
                </div>
              </td>
              <td className={BASE_CELL_CLASS}>
                {childFile.tempData
                  ? "..."
                  : childFile.size
                    ? formatBytesFromBigInt(BigInt(childFile.size))
                    : "Unknown"}
              </td>
              <td className={BASE_CELL_CLASS}>
                {childFile.createdAt === 0 ? (
                  "—"
                ) : (
                  <FormattedTimestamp
                    timestamp={childFile.createdAt}
                    className="text-grey-dark-800 text-xs font-medium tracking-[-0.24px]"
                  />
                )}
              </td>
              <td className={BASE_CELL_CLASS}>
                {childFile.isFolder
                  ? "Folder"
                  : getFileTypeDisplayLabel(fileType)}
              </td>
              <td className={cn(BASE_CELL_CLASS, "p-0")}>
                <div className="flex justify-center items-center">
                  <TableActionMenu dropdownTitle="" items={actionItems}>
                    <Button
                      variant="ghost"
                      size="auto"
                      className="h-6 w-6 p-0 text-grey-70 action-menu-area"
                    >
                      <MoreVertical className="size-4" />
                    </Button>
                  </TableActionMenu>
                </div>
              </td>
            </tr>

            {/* Recursive nested expansion — rendered as flat <tr> siblings
                in the same table, so column borders match every level. */}
            {isChildFolder && isSubfolderExpanded ? (
              <ExpandedFolderRows
                folder={childFile}
                accountId={accountId}
                syncPath={syncPath}
                label={label}
                baseSubfolderPath={folderRelativePath}
                depth={depth + 1}
                orderedColumnIds={orderedColumnIds}
                createTableItems={createTableItems}
                onSelectFile={onSelectFile}
                onRowContextMenu={onRowContextMenu}
                onOpenFolder={onOpenFolder}
                sortBy={sortBy}
                sortDir={sortDir}
                ancestorChain={
                  isSelected
                    ? [...ancestorChain, annotatedChild]
                    : ancestorChain
                }
                isItemDeleting={isItemDeleting}
              />
            ) : null}
          </React.Fragment>
        );
      })}

      {hasMore ? (
        <tr ref={sentinelRef} aria-hidden>
          <td colSpan={columnCount} style={{ height: "1px", padding: 0 }} />
        </tr>
      ) : null}
    </>
  );
};

export default ExpandedFolderRows;
