"use client";

import React from "react";
import { AbstractIconWrapper, Icons, RevealTextLine } from "@/components/ui";
import { InView } from "react-intersection-observer";
import { cn } from "@/app/lib/utils";
import {
  generateDesktopPaginationArray,
  generateMobilePaginationArray,
} from "@/app/lib/utils";
import Link from "next/link";
import { useBreakpoint } from "@/app/lib/hooks";
import { Table } from "@tanstack/react-table";

interface TablePaginationProps<TData> {
  table: Table<TData>;
  filteredData?: TData[];
  totalRecords?: number;
  itemsName?: string;
  allItemsLink?: string;
  allItemsText?: string;
  onPageChange?: (pageIndex: number) => void;
}

export const TablePagination = <TData,>({
  table,
  filteredData,
  totalRecords = 0,
  itemsName = "items",
  allItemsLink,
  allItemsText = "View All",
  onPageChange,
}: TablePaginationProps<TData>) => {
  const { isMobile } = useBreakpoint();
  const { pageIndex, pageSize: rawPageSize } = table.getState().pagination;
  const currentPage = pageIndex + 1;
  const pageCount = table.getPageCount();
  const canPrevious = table.getCanPreviousPage();
  const canNext = table.getCanNextPage();
  const pages = isMobile
    ? generateMobilePaginationArray(currentPage, pageCount)
    : generateDesktopPaginationArray(currentPage, pageCount);
  const totalCount = totalRecords || filteredData?.length;

  const pageSize = rawPageSize ?? totalCount;
  const totalCountNum =
    totalRecords > 0 ? totalRecords : (filteredData?.length ?? 0);

  // Calculate display values based on whether we're showing block ranges
  const displayStart = totalCount === 0 ? 0 : pageIndex * pageSize + 1;

  const displayEnd = Math.min(totalCountNum, (pageIndex + 1) * pageSize);

  const go = (newIndex: number) => {
    table.setPageIndex(newIndex);
    onPageChange?.(newIndex);
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="grid grid-cols-1 gap-4 desktop:grid-cols-3 items-center justify-items-center lg:justify-items-end lg:justify-between font-grotesk pt-4 lg:pt-8 overflow-hidden"
        >
          <div className="text-base text-grey-60 desktop:text-grey-20 font-medium justify-self-center desktop:justify-self-start ">
            <RevealTextLine
              reveal={inView}
              delay={100}
              className="flex flex-wrap"
            >
              <>
                Showing&nbsp;
                {displayStart.toLocaleString()}&nbsp;to&nbsp;
                {displayEnd.toLocaleString()}&nbsp;of&nbsp;
                {totalCountNum.toLocaleString()}&nbsp;
                {itemsName}
              </>
            </RevealTextLine>
          </div>

          <div className="flex items-center gap-2 justify-self-center">
            <button
              onClick={() => go(pageIndex - 1)}
              disabled={!canPrevious}
              className="mr-2 sm:mr-6 desktop:mr-0 2xl:mr-6 flex gap-2 text-grey-20 disabled:text-gray-400 disabled:cursor-not-allowed group"
            >
              <div
                className={cn(
                  "w-6 h-6 flex justify-center items-center border rounded-md opacity-0 translate-y-4 duration-500 transition-colors",
                  inView && "opacity-100 translate-y-0",
                  canPrevious
                    ? "border-grey-10 group-hover:bg-grey-80 text-grey-20"
                    : "border-gray-400 text-gray-400"
                )}
              >
                <Icons.PreviousLeftArrow className="h-2.5 w-[5px]" />
              </div>
              <RevealTextLine
                reveal={inView}
                delay={150}
                className={cn(
                  "hidden sm:block desktop:hidden 2xl:block text-base font-medium",
                  canPrevious && "group-hover:underline"
                )}
              >
                Previous
              </RevealTextLine>
            </button>

            {pages.map((pg, idx) =>
              pg === "..." ? (
                <span
                  key={`ellipsis-${idx}`}
                  className={cn(
                    "h-9 w-9 text-sm text-grey-70 rounded-lg font-medium p-2 bg-grey-90 hover:bg-grey-100 opacity-0 translate-y-4 duration-500 text-center",
                    inView && "opacity-100 translate-y-0",
                    inView && `transition-all delay-[${200 + idx * 50}ms]`
                  )}
                >
                  …
                </span>
              ) : pg === currentPage ? (
                <AbstractIconWrapper
                  key={pg}
                  className={cn(
                    "size-9 min-w-fit opacity-0 translate-y-7 duration-500 delay-300",
                    inView && "opacity-100 translate-y-0"
                  )}
                >
                  <div className="relative text-primary-40 text-sm rounded-lg font-medium">
                    {pg.toLocaleString()}
                  </div>
                </AbstractIconWrapper>
              ) : (
                <button
                  key={pg}
                  onClick={() => go(Number(pg) - 1)}
                  className={cn(
                    "min-h-9 min-w-9 text-sm text-grey-70 rounded-lg font-medium p-2 bg-grey-90 hover:bg-grey-80 hover:text-grey-20 transition-colors opacity-0 translate-y-4 duration-500",
                    inView && "opacity-100 translate-y-0",
                    inView && `transition-all delay-[${200 + idx * 50}ms]`
                  )}
                >
                  {pg.toLocaleString()}
                </button>
              )
            )}

            <button
              onClick={() => go(pageIndex + 1)}
              disabled={!canNext}
              className="ml-2 sm:ml-6 desktop:ml-0 2xl:ml-6 flex gap-2 text-grey-20 disabled:text-gray-400 disabled:cursor-not-allowed group"
            >
              <RevealTextLine
                reveal={inView}
                delay={150}
                className={cn(
                  "hidden sm:block desktop:hidden 2xl:block  text-base font-medium",
                  canNext && "group-hover:underline"
                )}
              >
                Next
              </RevealTextLine>
              <div
                className={cn(
                  "w-6 h-6 flex justify-center items-center border rounded-md opacity-0 translate-y-4 duration-500 transition-colors",
                  inView && "opacity-100 translate-y-0",
                  canNext
                    ? "border-grey-10 group-hover:bg-grey-80 text-grey-20"
                    : "border-gray-400 text-gray-400"
                )}
              >
                <Icons.NextRightArrow className="h-2.5 w-[5px]" />
              </div>
            </button>
          </div>

          <div className="flex justify-end justify-self-center desktop:justify-self-end">
            {allItemsLink && (
              <Link
                href={allItemsLink}
                className="flex gap-2 text-base text-grey-20 font-medium justify-center items-center group"
              >
                <RevealTextLine
                  reveal={inView}
                  delay={200}
                  className="group-hover:underline"
                >
                  {allItemsText} {itemsName}
                </RevealTextLine>
                <div
                  className={cn(
                    "opacity-0 translate-y-4 duration-500 delay-300 group-hover:translate-x-1 transition-transform",
                    inView && "opacity-100 translate-y-0"
                  )}
                >
                  <Icons.ForwardArrow className="h-6 w-6 font-medium" />
                </div>
              </Link>
            )}
          </div>
        </div>
      )}
    </InView>
  );
};
