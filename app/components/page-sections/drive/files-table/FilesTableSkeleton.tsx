"use client";

import React from "react";
import * as TableModule from "@/components/ui/alt-table";
import { cn } from "@/lib/utils";
import Skeleton from "@/components/ui/skeleton";

interface FilesTableSkeletonProps {
  isRecentFiles?: boolean;
  rows?: number;
  /** Match the real table's Added by column inside a shared drive. */
  showUploadedBy?: boolean;
}

// Mirrors `DEFAULT_COLUMN_WIDTHS_*` in files-table/index.tsx so
// the skeleton sits at the same column widths as the real table — when the
// data loads the columns don't shift.
const COLUMN_WIDTHS: Record<string, number> = {
  name: 47,
  size: 13,
  date_uploaded: 18,
  type: 17,
  actions: 5,
};

const COLUMN_WIDTHS_WITH_UPLOADER: Record<string, number> = {
  name: 42,
  size: 11,
  added_by: 18,
  date_uploaded: 14,
  type: 10,
  actions: 5,
};

const BASE_COLUMNS: Array<{
  id: string;
  label: string;
  skeletonWidth: string;
}> = [
  { id: "name", label: "Name", skeletonWidth: "70%" },
  { id: "size", label: "Size", skeletonWidth: "55%" },
  { id: "date_uploaded", label: "Date Uploaded", skeletonWidth: "65%" },
  { id: "type", label: "File Type", skeletonWidth: "50%" },
  { id: "actions", label: "", skeletonWidth: "20px" },
];

const UPLOADER_COLUMN = {
  id: "added_by",
  label: "Added by",
  skeletonWidth: "55%",
};

const SKELETON_BAR_CLASS =
  "rounded-full bg-grey-80 dark:bg-black-300 animate-pulse";

/**
 * Table-shaped skeleton rendered while the real FilesTable data is loading.
 * Mirrors the visible header labels and column widths of files-table/index.tsx
 * so there is no visual jump when the real rows replace the placeholders.
 */
const FilesTableSkeleton: React.FC<FilesTableSkeletonProps> = ({
  isRecentFiles = false,
  rows,
  showUploadedBy = false,
}) => {
  const widths = showUploadedBy ? COLUMN_WIDTHS_WITH_UPLOADER : COLUMN_WIDTHS;
  const columns = showUploadedBy
    ? [
        BASE_COLUMNS[0],
        BASE_COLUMNS[1],
        UPLOADER_COLUMN,
        ...BASE_COLUMNS.slice(2),
      ]
    : BASE_COLUMNS;

  return (
  <div
    className={cn(
      "flex flex-col gap-y-8 relative",
      // The 700px floor is for the lazily-revealed list, whose final height
      // nothing knows in advance. A paged table DOES know: its caller passes
      // the page size, so the skeleton is exactly as tall as the rows about
      // to replace it. Keeping the floor there paints a full-height block for
      // a ten-row page and then collapses, which is the jump the skeleton is
      // supposed to prevent.
      !isRecentFiles && rows === undefined && "min-h-[43.75rem]",
    )}
  >
    <div className="w-full relative">
      <TableModule.TableWrapper
        className={cn(
          "duration-300 delay-300 bg-white border-grey-dark-100 rounded-[8px] dark:bg-black-600 dark:border-black-300",
          !isRecentFiles && "rounded-none border-0 bg-transparent",
        )}
      >
        <table
          className="w-full table-fixed border-collapse"
          style={{ borderSpacing: 0 }}
        >
          <colgroup>
            {columns.map((col) => (
              <col
                key={col.id}
                style={{ width: `${widths[col.id]}%` }}
              />
            ))}
          </colgroup>
          <thead
            className={cn(
              "bg-table-header dark:bg-transparent",
              !isRecentFiles && "!bg-transparent",
            )}
          >
            <tr className="border-b border-grey-dark-100 dark:border-black-300">
              {columns.map((col) => (
                <th
                  key={col.id}
                  className={cn(
                    "h-8 px-2 py-2 border-x-0 border-r last:border-r-0 border-grey-dark-100 text-grey-dark-600 font-semibold text-xs text-left dark:bg-black-600 dark:border-black-300 dark:text-grey-dark-300",
                  )}
                >
                  <span className="uppercase">{col.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows ?? (isRecentFiles ? 5 : 8) }).map((_, rowIndex) => (
              <tr
                key={`skeleton-row-${rowIndex}`}
                className="border-b-0 odd:bg-grey-light-200 even:bg-grey-light-400 dark:odd:bg-black-500 dark:even:bg-black-primary-bg"
              >
                {columns.map((col) => (
                  <td
                    key={`skeleton-cell-${rowIndex}-${col.id}`}
                    className={cn(
                      "px-2 py-[10px] h-9 border-x-0 border-r last:border-r-0 border-grey-dark-100 dark:border-black-300",
                      col.id === "actions" && "text-center px-0",
                    )}
                  >
                    <Skeleton
                      height="0.75rem"
                      width={col.skeletonWidth}
                      className={cn(
                        SKELETON_BAR_CLASS,
                        col.id === "actions" && "mx-auto",
                      )}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </TableModule.TableWrapper>
    </div>
  </div>
  );
};

export default FilesTableSkeleton;

/**
 * Inline skeleton rows used when an inline-expanded folder is loading its
 * children. Renders as flat `<tr>` siblings inside the outer FilesTable so
 * column borders line up with the parent rows (mirrors the layout
 * convention documented in ExpandedFolderRows.tsx).
 */
export const FolderRowsSkeleton: React.FC<{
  rows?: number;
  orderedColumnIds: string[];
  /** Pixel offset that aligns the leading skeleton bar with the nested
   *  row's chevron slot (matches `depthIndentStyle` in ExpandedFolderRows
   *  so the skeleton lines up with the children that follow). */
  nameIndentPx: number;
}> = ({ rows = 3, orderedColumnIds, nameIndentPx }) => {
  const skeletonByColumn: Record<string, string> = {
    selection: "16px",
    name: "60%",
    size: "55%",
    added_by: "55%",
    date_uploaded: "65%",
    type: "50%",
    actions: "20px",
  };

  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr
          key={`folder-skeleton-row-${rowIndex}`}
          className="border-b-0 odd:bg-grey-light-200 even:bg-grey-light-400 dark:odd:bg-black-500 dark:even:bg-black-primary-bg"
        >
          {orderedColumnIds.map((columnId) => {
            const isName = columnId === "name";
            const isActions = columnId === "actions";
            const isSelection = columnId === "selection";
            return (
              <td
                key={`folder-skeleton-${rowIndex}-${columnId}`}
                className={cn(
                  "px-2 py-[10px] h-9 border-x-0 border-r last:border-r-0 border-grey-dark-100 dark:border-black-300",
                  isActions && "text-center px-0",
                  isSelection && "px-0 text-center",
                  isName && "p-0",
                )}
              >
                {isName ? (
                  <div
                    className="flex items-center py-[5px] pr-2"
                    style={{ paddingLeft: `${nameIndentPx}px` }}
                  >
                    <Skeleton
                      height="0.75rem"
                      width={skeletonByColumn[columnId]}
                      className={SKELETON_BAR_CLASS}
                    />
                  </div>
                ) : (
                  <Skeleton
                    height="0.75rem"
                    width={skeletonByColumn[columnId] ?? "60%"}
                    className={cn(
                      SKELETON_BAR_CLASS,
                      (isActions || isSelection) && "mx-auto",
                    )}
                  />
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
};
