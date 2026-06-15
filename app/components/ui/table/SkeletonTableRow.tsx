import React from "react";
import Skeleton from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface SkeletonTableRowProps {
  rows: number;
  columns: number;
  cellClassName?: string;
  rowClassName?: string;
  columnWidths?: string[];
  columnClassNames?: (string | undefined)[];
  showBorders?: boolean;
  skeletonClassName?: string;
  skeletonHeight?: string | number;
}

export const SkeletonTableRow: React.FC<SkeletonTableRowProps> = ({
  rows,
  columns,
  cellClassName = "",
  rowClassName = "",
  columnWidths,
  columnClassNames,
  showBorders = true,
  skeletonClassName = "",
  skeletonHeight = "var(--table-skeleton-height,16px)",
}) => (
  <>
    {Array.from({ length: rows }).map((_, rowIndex) => (
      <tr
        key={rowIndex}
        className={cn("bg-white dark:bg-black-600", rowClassName)}
      >
        {Array.from({ length: columns }).map((_, colIndex) => {
          const skeletonWidth =
            columnWidths?.[colIndex] ??
            (colIndex === 0 ? "80px" : colIndex === columns - 1 ? "24px" : "100%");

          return (
            <td
              key={colIndex}
              className={cn(
                "h-[var(--table-row-height,36px)] overflow-hidden border-b",
                "border-grey-dark-100 px-[var(--table-cell-padding-x,10px)] py-0 align-middle",
                "dark:border-black-300",
                showBorders && "border-r last:border-r-0",
                cellClassName,
                columnClassNames?.[colIndex],
              )}
            >
              <Skeleton
                height={skeletonHeight}
                width={skeletonWidth}
                className={cn(
                  "rounded-full bg-grey-80 dark:bg-black-300",
                  skeletonClassName,
                )}
              />
            </td>
          );
        })}
      </tr>
    ))}
  </>
);
