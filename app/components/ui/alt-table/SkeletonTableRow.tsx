import React from "react";
import { cn } from "@/lib/utils";
import Skeleton from "../skeleton";

interface SkeletonTableRowProps {
  rows: number;
  columns: number;
  cellClassName?: string;
  rowClassName?: string;
  columnWidths?: string[];
  showBorders?: boolean;
  /**
   * Skeleton height inside each cell. Defaults to `1.25rem` to preserve the
   * existing visual; callers building compact rows (e.g. the Figma-spec VM
   * table) can shrink this to keep the placeholder shorter than the row.
   */
  skeletonHeight?: string;
}

export const SkeletonTableRow: React.FC<SkeletonTableRowProps> = ({
  rows,
  columns,
  cellClassName = "",
  rowClassName = "",
  columnWidths,
  showBorders = true,
  skeletonHeight = "1.25rem",
}) => {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr
          key={`skeleton-row-${rowIndex}`}
          className={cn(
            "bg-grey-100 text-left text-sm font-grotesk h-10 animate-fade-in-0.3",
            rowClassName
          )}
        >
          {Array.from({ length: columns }).map((_, colIndex) => {
            const isLastCol = colIndex === columns - 1;

            // Determine skeleton width — use columnWidths if provided, else
            // default to a narrow id/actions hint for the edges.
            let skeletonWidth = "100%";
            if (columnWidths && columnWidths[colIndex]) {
              skeletonWidth = columnWidths[colIndex];
            } else if (colIndex === 0) {
              skeletonWidth = "5rem";
            } else if (isLastCol) {
              skeletonWidth = "1.5rem";
            }

            return (
              <td
                key={`skeleton-cell-${rowIndex}-${colIndex}`}
                className={cn(
                  "px-2.5 py-3 border-b border-grey-80 align-middle h-10",
                  showBorders && !isLastCol && "border-r border-grey-80",
                  cellClassName
                )}
              >
                <Skeleton height={skeletonHeight} width={skeletonWidth} />
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
};
