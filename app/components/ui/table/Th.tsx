import React from "react";
import { cn } from "@/lib/utils";
import { Header, flexRender } from "@tanstack/react-table";
import { ChevronDown } from "lucide-react";

type TableColumnMeta = { headerClassName?: string };

export interface ThProps<TData, TValue>
  extends React.ThHTMLAttributes<HTMLTableCellElement> {
  header?: Header<TData, TValue>;
  align?: "center" | "left" | "right";
  activeSortClassName?: string;
}

export function Th<TData, TValue>({
  header,
  className,
  activeSortClassName,
  align,
  children,
  onClick,
  ...rest
}: ThProps<TData, TValue>) {
  const sortOrder = header?.column.getIsSorted();
  const canSort = header?.column.getCanSort() ?? false;
  const toggleSort = canSort ? header?.column.getToggleSortingHandler() : null;
  const headerClassName = (
    header?.column.columnDef.meta as TableColumnMeta
  )?.headerClassName;

  return (
    <th
      className={cn(
        "h-[var(--table-row-height,36px)] border-b border-r border-grey-dark-100",
        "px-[var(--table-cell-padding-x,10px)] py-0 text-left",
        "text-[length:var(--table-header-font-size,10px)]",
        "leading-[var(--table-header-line-height,14px)] font-semibold uppercase",
        "last:border-r-0 dark:border-black-300",
        canSort && "cursor-pointer select-none",
        // Sorted column gets an emphasized color; unsorted columns stay dim.
        // The default is applied even when `activeSortClassName` is omitted so
        // a sorted header is never invisible in dark mode against the
        // #111111 thead surface. Callers can still override via the prop —
        // tailwind-merge dedupes when the override repeats the default.
        sortOrder && canSort
          ? cn("text-grey-10 dark:text-grey-light-100", activeSortClassName)
          : "text-grey-dark-600 dark:text-grey-dark-700",
        headerClassName,
        className,
      )}
      onClick={toggleSort ?? onClick}
      {...rest}
    >
      <div
        className={cn(
          "flex w-full",
          align === "center" && "justify-center",
          align === "right" && "justify-end",
        )}
      >
        {header?.isPlaceholder ? null : canSort && header ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleSort?.(e);
            }}
            className="inline-flex items-center gap-1 whitespace-nowrap uppercase"
          >
            {flexRender(header.column.columnDef.header, header.getContext())}
            {sortOrder && (
              <ChevronDown
                className={cn(
                  "size-[calc(var(--table-header-font-size,10px)+2px)] transition-transform",
                  sortOrder === "asc" && "rotate-180",
                )}
              />
            )}
          </button>
        ) : header ? (
          flexRender(header.column.columnDef.header, header.getContext())
        ) : (
          children
        )}
      </div>
    </th>
  );
}
