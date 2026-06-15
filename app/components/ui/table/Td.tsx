import React from "react";
import { cn } from "@/lib/utils";
import { Cell, flexRender } from "@tanstack/react-table";

type TableColumnMeta = { cellClassName?: string };

export interface TdProps<TData, TValue>
  extends React.ThHTMLAttributes<HTMLTableCellElement> {
  cell?: Cell<TData, TValue>;
  activeSortClassName?: string;
}

export function Td<TData, TValue>({
  cell,
  className,
  activeSortClassName,
  children,
  ...rest
}: TdProps<TData, TValue>) {
  const sortOrder = cell?.column.getIsSorted();
  const canSort = cell?.column.getCanSort() ?? false;
  const cellClassName = (
    cell?.column.columnDef.meta as TableColumnMeta
  )?.cellClassName;

  return (
    <td
      className={cn(
        "h-[var(--table-row-height,36px)] border-b border-r border-grey-dark-100",
        "px-[var(--table-cell-padding-x,10px)] py-0 align-middle",
        "text-[length:var(--table-font-size,12px)]",
        "leading-[var(--table-line-height,16px)]",
        "last:border-r-0 dark:border-black-300",
        cellClassName,
        className,
        canSort && sortOrder && activeSortClassName,
      )}
      {...rest}
    >
      {cell ? flexRender(cell.column.columnDef.cell, cell.getContext()) : children}
    </td>
  );
}
