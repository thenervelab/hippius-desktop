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
import { useInfiniteScroll } from "@/lib/hooks/use-infinite-scroll";
import { useNestedFolderListing } from "@/app/lib/hooks/use-nested-folder-listing";
import { useFileSelection } from "@/app/contexts/FileSelectionContext";
import TableActionMenu, {
  type ActionItem,
} from "@/app/components/ui/alt-table/TableActionMenu";
import FileCheckbox from "./FileCheckbox";
import NameCell from "./NameCell";
import { VideoDialogTrigger } from "./VideoDialog";
import { ImageDialogTrigger } from "./ImageDialog";
import { PdfDialogTrigger } from "./PdfDialog";
import { FolderRowsSkeleton } from "./FilesTableSkeleton";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const TIME_BEFORE_ERR = 30 * 60 * 1000;
const MAX_INLINE_DEPTH = 8;
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
  ) => ActionItem[];
  onSelectFile: (file: FormattedUserFile) => void;
  onRowContextMenu?: (event: React.MouseEvent, file: FormattedUserFile) => void;
  onOpenFolder?: (folder: FormattedUserFile) => void;
  sortBy?: "name" | "size" | "date_uploaded";
  sortDir?: "asc" | "desc";
}

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
}) => {
  const { isSelectionMode, toggleFileSelection, isFileSelected } =
    useFileSelection();
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

  const { data, isLoading } = useNestedFolderListing({
    accountId,
    syncPath,
    subfolder: listingEnabled ? folderRelativePath : null,
    label: label ?? null,
    enabled: listingEnabled,
  });

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

  const { visibleData, hasMore, loadMore } = useInfiniteScroll(sortedChildRows);
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
    () => ({ paddingLeft: `${BASE_CHILD_INDENT_PX + (depth + 1) * DEPTH_INDENT_PX}px` }),
    [depth],
  );

  const handleToggleSubfolder = useCallback(
    (childFile: FormattedUserFile, childPath: string) => {
      if (depth >= MAX_INLINE_DEPTH) {
        onOpenFolder?.(childFile);
        return;
      }
      setExpandedSubfolders((previous) => ({
        ...previous,
        [childPath]: !previous[childPath],
      }));
    },
    [depth, onOpenFolder],
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

  if (!listingEnabled) {
    return (
      <tr className="bg-grey-light-200 dark:bg-black-500">
        {renderLeadingRailCells("unavailable")}
        <td
          colSpan={columnCount - (hasSelectionColumn ? 1 : 0)}
          className="px-3 py-2 text-xs text-grey-60"
        >
          Folder listing is unavailable.
        </td>
      </tr>
    );
  }

  if (isLoading) {
    return (
      <FolderRowsSkeleton
        orderedColumnIds={orderedColumnIds}
        nameIndentPx={BASE_CHILD_INDENT_PX + (depth + 1) * DEPTH_INDENT_PX}
      />
    );
  }

  if (!visibleData.length) {
    return (
      <tr className="bg-grey-light-200 dark:bg-black-500">
        {renderLeadingRailCells("empty")}
        <td
          colSpan={columnCount - (hasSelectionColumn ? 1 : 0)}
          className="px-3 py-2 text-xs text-grey-60"
        >
          Folder is empty.
        </td>
      </tr>
    );
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
        const isSelected = isFileSelected(childFile);
        const canSelect = childFile.isAssigned;
        const isChildFolder = Boolean(childFile.isFolder);
        const childRelativePath = resolveRelativePath(
          folderRelativePath,
          childFile.actualFileName || childFile.name,
        );
        const isSubfolderExpanded =
          isChildFolder && Boolean(expandedSubfolders[childRelativePath]);

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
          />
        );

        const nameContent =
          !isSelectionMode && fileType === "video" ? (
            <VideoDialogTrigger
              onClick={() => onSelectFile(childFile)}
              className="min-w-0 px-0 py-0"
            >
              {nameNode}
            </VideoDialogTrigger>
          ) : !isSelectionMode && fileType === "image" ? (
            <ImageDialogTrigger
              onClick={() => onSelectFile(childFile)}
              className="min-w-0 px-0 py-0"
            >
              {nameNode}
            </ImageDialogTrigger>
          ) : !isSelectionMode && fileType === "PDF" ? (
            <PdfDialogTrigger
              onClick={() => onSelectFile(childFile)}
              className="min-w-0 px-0 py-0"
            >
              {nameNode}
            </PdfDialogTrigger>
          ) : (
            nameNode
          );

        const actionItems = createTableItems(
          childFile,
          fileType,
          childFile.arionHash,
          true,
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
              onContextMenu={(event) => onRowContextMenu?.(event, childFile)}
              onClick={(event) => {
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
                  toggleFileSelection(childFile);
                }
              }}
            >
              {hasSelectionColumn ? (
                <td className={cn(BASE_CELL_CLASS, "px-2 py-[5px] text-center")}>
                  <div className="flex justify-center checkbox-container">
                    <FileCheckbox
                      selected={isSelected}
                      onChange={() => toggleFileSelection(childFile)}
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
                          handleToggleSubfolder(childFile, childRelativePath);
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
