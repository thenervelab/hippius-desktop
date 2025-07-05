"use client";

import React from "react";
import { cn, getPaginationPageList } from "@/lib/utils";
import AbstractIconWrapper from "../abstract-icon-wrapper";
import { Icons } from "..";

interface TablePaginationProps {
  currentPage: number;
  totalPages: number;
  setPage: (v: number) => void;
  className?: string;
}

export const Pagination: React.FC<TablePaginationProps> = ({
  currentPage,
  totalPages,
  setPage,
  className,
}) => {
  const pageData = getPaginationPageList({
    currentPage,
    totalPages,
  });

  const canShowPrev = currentPage > 1;
  const canShowNext = currentPage < totalPages;

  return (
    <div
      className={cn(
        "flex animate-fade-in-0.3 flex-wrap justify-center gap-y-4",
        className
      )}
    >
      <div className="w-2/4 sm:w-fit px-4 sm:px-8 flex justify-end items-center">
        <button
          disabled={!canShowPrev}
          onClick={() => {
            setPage(Math.max(1, currentPage - 1));
          }}
          className={cn(
            "flex items-center gap-x-2 duration-300 text-sm sm:text-base",
            !canShowPrev ? "opacity-30 cursor-not-allowed" : "hover:opacity-70"
          )}
        >
          <Icons.ArrowSquareDown className="rotate-90 size-5" />
          Previous
        </button>
      </div>
      <div className="flex gap-x-2 order-3 sm:order-2">
        {pageData.map((p, i) => {
          const isActive = p === currentPage;
          return (
            <div
              className={cn(
                "size-7 sm:size-9 bg-grey-90 relative rounded-lg border border-transparent flex items-center justify-center font-medium text-xs sm:text-sm text-grey-70 overflow-hidden",
                isActive && "text-primary-40 border-primary-60 bg-transparent"
              )}
              key={`${i}-${currentPage}`}
            >
              {p < 0 ? (
                "..."
              ) : (
                <button
                  className="w-full relative h-full"
                  onClick={() => {
                    setPage(p);
                  }}
                >
                  {isActive ? (
                    <AbstractIconWrapper className="absolute animate-fade-in-from-b-0.3 top-0 left-0 w-full h-full">
                      <span className="absolute">{p}</span>
                    </AbstractIconWrapper>
                  ) : (
                    p
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="order-2 sm:order-3 w-2/4 sm:w-fit px-4 sm:px-8 flex items-center">
        <button
          disabled={!canShowNext}
          onClick={() => {
            setPage(Math.min(totalPages, currentPage + 1));
          }}
          className={cn(
            "flex items-center gap-x-2 duration-300 text-sm sm:text-base",
            !canShowNext ? "opacity-30 cursor-not-allowed" : "hover:opacity-70"
          )}
        >
          Next
          <Icons.ArrowSquareDown className="-rotate-90 size-5" />
        </button>
      </div>
    </div>
  );
};

export default Pagination;
