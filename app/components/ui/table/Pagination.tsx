"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { getPaginationPageList } from "@/lib/utils/getPaginationPageList";
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

      {/* Page buttons — center */}
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
              className="h-8 w-full rounded-[8px] border border-[#e4e4e7] bg-white px-[10px] font-geist text-[14px] font-medium uppercase tracking-[-0.28px] text-[#585858] shadow-[0px_2px_5px_0px_rgba(0,0,0,0.05)] dark:border-black-300 dark:bg-white/[0.02] dark:text-[#ffffff79]"
            >
              {pageSizeOptions.map((o) => (
                <option key={o} value={o}>
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
