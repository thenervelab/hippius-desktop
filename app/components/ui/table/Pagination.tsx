"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { getPaginationPageList } from "@/lib/utils/getPaginationPageList";
import { buildPageSizeOptions } from "./pageSizeOptions";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface TablePaginationProps {
  currentPage: number;
  totalPages: number;
  setPage: (v: number) => void;
  className?: string;
  totalCount?: number;
  pageSize?: number;
  setPageSize?: (v: number) => void;
  pageSizeOptions?: number[];
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

const PaginationButton = ({
  active = false,
  disabled = false,
  onClick,
  children,
  className,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={cn(
      "inline-flex h-8 min-w-8 items-center justify-center rounded-[8px] border",
      "px-[13px] text-[14px] font-medium tracking-[-0.28px] transition-colors",
      active
        ? "border-[#e4e4e7] bg-white text-[#585858] shadow-[0px_1px_0px_0px_white,0px_2px_5px_0px_rgba(0,0,0,0.05)] dark:border-black-300 dark:bg-white/[0.02] dark:text-grey-light-100 dark:shadow-[0px_0px_0px_1px_black]"
        : "border-[rgba(0,0,0,0.16)] bg-white/10 text-[rgba(0,0,0,0.47)] dark:border-black-300 dark:bg-white/[0.02] dark:text-grey-light-100/60",
      disabled && "cursor-not-allowed opacity-50",
      className,
    )}
  >
    {children}
  </button>
);

export const Pagination: React.FC<TablePaginationProps> = ({
  currentPage,
  totalPages,
  setPage,
  className,
  totalCount,
  pageSize,
  setPageSize,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
}) => {
  const pageData = getPaginationPageList({ currentPage, totalPages });
  // Latch the size the table opened on. Merging only the CURRENT size made a
  // non-preset default a one-way door: Drive opens at 20 (not a preset), and
  // picking 25 recomputed the 20 option away for the rest of the session.
  // A ref, not state — this never needs to trigger a re-render, and the first
  // defined size is the answer forever.
  const initialPageSizeRef = React.useRef<number | undefined>(pageSize);
  if (initialPageSizeRef.current === undefined && pageSize !== undefined) {
    initialPageSizeRef.current = pageSize;
  }
  const sizeOptions = React.useMemo(
    () =>
      buildPageSizeOptions({
        options: pageSizeOptions,
        current: pageSize,
        initial: initialPageSizeRef.current,
      }),
    [pageSizeOptions, pageSize],
  );
  const rangeLabel =
    totalCount && pageSize
      ? `${(currentPage - 1) * pageSize + 1}-${Math.min(currentPage * pageSize, totalCount)} OUT OF ${totalCount}`
      : null;

  return (
    <div
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-0",
        className,
      )}
    >
      {/* Range label — desktop left */}
      <div className="hidden sm:order-1 sm:block sm:flex-1">
        {rangeLabel && (
          <p className="font-geist text-[14px] font-medium uppercase tracking-[-0.28px] text-[rgba(0,0,0,0.47)] dark:text-[#ffffff79]">
            {rangeLabel}
          </p>
        )}
      </div>

      {/* Page buttons — center.
          Dropped entirely on a single page: arrows that can never be enabled
          and a lone "1" are controls with nothing to do. The row still
          carries the range label and the size control, which is why it can
          be shown at all on one page — a reader who chose 50 needs the way
          back to 20 even when everything fits. */}
      {totalPages > 1 && (
        <div className="order-1 flex flex-wrap items-center justify-center gap-2 sm:order-2 sm:gap-3">
          <PaginationButton
            disabled={currentPage <= 1}
            onClick={() => setPage(Math.max(1, currentPage - 1))}
            className="px-0"
          >
            <ChevronLeft className="size-4 text-[#6A7282] dark:text-grey-light-100" />
          </PaginationButton>

          {pageData.map((p, i) =>
            p < 0 ? (
              <span
                key={`${p}-${i}`}
                className="px-1 text-[14px] font-medium tracking-[-0.28px] text-[rgba(0,0,0,0.47)] dark:text-[#ffffff79]"
              >
                ...
              </span>
            ) : (
              <PaginationButton
                key={p}
                active={p === currentPage}
                onClick={() => setPage(p)}
              >
                {p}
              </PaginationButton>
            ),
          )}

          <PaginationButton
            disabled={currentPage >= totalPages}
            onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
            className="px-0"
          >
            <ChevronRight className="size-4 text-[#6A7282] dark:text-grey-light-100" />
          </PaginationButton>
        </div>
      )}

      {/* Page size + mobile range label — right */}
      <div className="order-3 flex items-center justify-between sm:flex-1 sm:justify-end">
        <div className="sm:hidden">
          {rangeLabel && (
            <p className="font-geist text-[14px] font-medium uppercase tracking-[-0.28px] text-[rgba(0,0,0,0.47)] dark:text-[#ffffff79]">
              {rangeLabel}
            </p>
          )}
        </div>
        <div className="w-[106px]">
          {setPageSize && pageSize && (
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              // The OPEN list is drawn by the OS, not by us, and it takes its
              // colours from `color-scheme` and from the select's own
              // background/text — not from any `dark:` class on the options.
              // Left at the light default it painted a white popup and
              // inherited the translucent white text, so every option was
              // invisible in dark mode while the closed control looked right.
              // `dark:[color-scheme:dark]` is what makes the popup dark; the
              // opaque background and full-strength text are what keep the
              // options legible on the engines that inherit them instead.
              className="h-8 w-full rounded-[8px] border border-[#e4e4e7] bg-white px-[10px] font-geist text-[14px] font-medium uppercase tracking-[-0.28px] text-[#585858] shadow-[0px_2px_5px_0px_rgba(0,0,0,0.05)] dark:border-black-300 dark:bg-black-500 dark:text-grey-light-200 dark:[color-scheme:dark]"
            >
              {sizeOptions.map((o) => (
                <option
                  key={o}
                  value={o}
                  className="bg-white text-[#585858] dark:bg-black-500 dark:text-grey-light-200"
                >
                  {o}/PAGE
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </div>
  );
};
