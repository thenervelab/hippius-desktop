import { cn } from "@/lib/utils";
import { Header, flexRender } from "@tanstack/react-table";
import { ChevronDown } from "@/components/ui/icons";
import React from "react";

export interface ThProps<TData, TValue>
  extends React.ThHTMLAttributes<HTMLTableCellElement> {
  header: Header<TData, TValue>;
  align?: "center" | "left" | "right";
  activeSortClassName?: string;
  columnWidth?: number; // percentage
  onResizeStart?: (columnId: string, startX: number) => void;
  preventSort?: boolean;
}

export function Th<TData, TValue>(props: ThProps<TData, TValue>) {
  const {
    onClick,
    header,
    className,
    activeSortClassName,
    align,
    columnWidth,
    onResizeStart,
    preventSort,
    ...rest
  } = props;

  const sortOrder = header.column.getIsSorted();
  const canSort = header.column.getCanSort();

  // Allow resizing all except an "actions" column (if you use one)
  const canResize = header.id !== "actions";

  return (
    <th
      className={cn(
        "font-semibold text-xs px-2.5 border-x first:border-l-transparent last:border-r-transparent border-b py-3 text-grey-70 relative",
        canSort && "pr-8 cursor-pointer hover:bg-gray-50/30",
        sortOrder && canSort && cn("text-primary-50", activeSortClassName),
        className
      )}
      style={{
        width: columnWidth ? `${columnWidth}%` : undefined,
      }}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest(".resize-handle")) {
          return; // ignore clicks on the resize handle
        }
        if (preventSort) return;
        if (canSort) {
          header.column.toggleSorting();
        }
        if (onClick) onClick(event);
      }}
      {...rest}
    >
      <div
        className={cn(
          "flex w-full",
          align === "center" && "justify-center",
          align === "left" && "justify-start",
          align === "right" && "justify-end"
        )}
      >
        {canSort ? (
          <button
            className={cn(
              "relative flex h-fit w-fit whitespace-nowrap",
              header.column.columnDef.header !== "hALPHA EARNED" && "uppercase"
            )}
          >
            {flexRender(header.column.columnDef.header, header.getContext())}
            {sortOrder && canSort && (
              <ChevronDown
                className={cn(
                  "absolute mt-0.5 -right-5 w-4 text-primary-50 duration-300",
                  sortOrder === "asc" && "rotate-180"
                )}
              />
            )}
          </button>
        ) : (
          <span className="uppercase">
            {flexRender(header.column.columnDef.header, header.getContext())}
          </span>
        )}
      </div>

      {canResize && (
        <div
          className="resize-handle absolute top-0 right-0 h-full w-2 -mr-1 cursor-col-resize z-10 select-none"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation(); // avoid toggling sort
            onResizeStart?.(header.id, e.clientX);
          }}
        />
      )}
    </th>
  );
}
