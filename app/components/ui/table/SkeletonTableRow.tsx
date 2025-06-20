import React from "react";
import { Skeleton } from "@/components/ui";
import { cn } from "@/app/lib/utils";

interface SkeletonTableRowProps {
  rows: number;
  columns: number;
  cellClassName?: string;
  rowClassName?: string;
  columnWidths?: string[];
  showBorders?: boolean;
}

export const SkeletonTableRow: React.FC<SkeletonTableRowProps> = ({
  rows,
  columns,
  cellClassName = "",
  rowClassName = "",
  columnWidths,
  showBorders = true,
}) => {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr
          key={`skeleton-row-${rowIndex}`}
          className={cn(
            "bg-grey-100 text-left text-base font-grotesk h-12 animate-fade-in-0.3",
            rowClassName
          )}
        >
          {Array.from({ length: columns }).map((_, colIndex) => {
            // Base cell styling
            let tdClasses = `px-4 py-[13px] border-b border-grey-80 align-middle h-12 ${cellClassName}`;

            // Add vertical borders if enabled
            if (showBorders && colIndex !== columns - 1) {
              tdClasses += " border-r border-grey-80";
            }

            // Determine skeleton width - use columnWidths if provided or default
            let skeletonWidth = "100%";
            if (columnWidths && columnWidths[colIndex]) {
              skeletonWidth = columnWidths[colIndex];
            } else if (colIndex === 0) {
              // Default for first column (usually ID)
              skeletonWidth = "80px";
            } else if (colIndex === columns - 1) {
              // Default for last column (usually actions)
              skeletonWidth = "24px";
            }

            return (
              <td
                key={`skeleton-cell-${rowIndex}-${colIndex}`}
                className={tdClasses}
              >
                <Skeleton
                  height="1.25rem"
                  width={skeletonWidth}
                />
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
};
