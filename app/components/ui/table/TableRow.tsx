import React from "react";
import { Row, flexRender } from "@tanstack/react-table";
import { cn } from "@/app/lib/utils";

interface MyColumnMeta {
  cellClassName?: string;
}

interface TableRowProps<T> {
  row: Row<T>;
}

export function TableRow<T>({ row }: TableRowProps<T>) {
  return (
    <tr className="bg-grey-100 text-left animate-fade-in-0.3 text-base font-grotesk text-grey-20 font-medium hover:bg-grey-90 h-12">
      {row.getVisibleCells().map((cell) => {
        const meta = cell.column.columnDef.meta as MyColumnMeta | undefined;
        const cellClass = meta?.cellClassName;

        return (
          <td
            key={cell.id}
            className={cn(
              "px-4 py-[13px] text-sm md:text-base border-b align-middle h-12 border-r border-grey-80",
              cellClass
            )}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </td>
        );
      })}
    </tr>
  );
}
