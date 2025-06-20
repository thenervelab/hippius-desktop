"use client";
import React from "react";
import { flexRender, Table } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { Icons } from "@/components/ui";

interface TableHeaderProps<T> {
  table: Table<T>;
}

export function TableHeader<T>({ table }: TableHeaderProps<T>) {
  return (
    <thead className="bg-[#FAFAFA] text-sm font-grotesk text-grey-70 uppercase font-semibold">
      {table.getHeaderGroups().map((headerGroup) => (
        <tr key={headerGroup.id}>
          {headerGroup.headers.map((header) => {
            const canSort = header.column.getCanSort();
            const sortDirection = header.column.getIsSorted();
            return (
              <th
                key={header.id}
                className={cn(
                  "px-4 py-3.5 text-sm md:text-base text-left border-b border-r border-grey-80 align-middle",
                  canSort && "cursor-pointer select-none"
                )}
                // our custom two-state toggler:
                onClick={
                  canSort
                    ? () => {
                        const isDesc = sortDirection === "desc";
                        header.column.toggleSorting(!isDesc);
                      }
                    : undefined
                }
              >
                {canSort ? (
                  <button className="relative flex h-fit w-fit whitespace-nowrap">
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext()
                    )}
                    {sortDirection && (
                      <Icons.ChevronDown
                        className={cn(
                          "absolute mt-0.5 -right-4 md:-right-5 w-4 h-4 transition-transform",
                          sortDirection === "asc" && "transform rotate-180"
                        )}
                      />
                    )}
                  </button>
                ) : (
                  <div className="relative flex items-center">
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext()
                    )}
                  </div>
                )}
              </th>
            );
          })}
        </tr>
      ))}
    </thead>
  );
}
