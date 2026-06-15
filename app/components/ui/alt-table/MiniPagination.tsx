"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { Icons } from "..";

interface MiniPaginationControlProps {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalCount: number;
  onPrev: () => void;
  onNext: () => void;
  className?: string;
}

export const MiniPaginationControl: React.FC<MiniPaginationControlProps> = ({
  currentPage,
  totalPages,
  pageSize,
  totalCount,
  onPrev,
  onNext,
  className,
}) => {
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalCount);

  return (
    <div
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-[7px] border px-2",
        "bg-grey-light-700 border-grey-dark-100",
        "dark:bg-black-300 dark:border-black-300",
        className,
      )}
    >
      <button
        type="button"
        onClick={onPrev}
        disabled={currentPage <= 1}
        className={cn(
          "flex size-5 items-center justify-center rounded transition-colors",
          currentPage <= 1
            ? "opacity-40"
            : "hover:bg-black/5 dark:hover:bg-white/10",
        )}
        aria-label="Previous page"
      >
        <Icons.ArrowLeft className="size-3.5 text-black-700 dark:text-grey-dark-700" />
      </button>
      <span className="whitespace-nowrap font-sans text-[12px] font-medium tabular-nums tracking-[-0.12px] text-black-700 dark:text-grey-dark-700">
        {totalCount > 0 ? `${start}-${end} (${totalCount})` : "0-0 (0)"}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={currentPage >= totalPages}
        className={cn(
          "flex size-5 items-center justify-center rounded transition-colors",
          currentPage >= totalPages
            ? "opacity-40"
            : "hover:bg-black/5 dark:hover:bg-white/10",
        )}
        aria-label="Next page"
      >
        <Icons.ArrowRight className="size-3.5 text-black-700 dark:text-grey-dark-700" />
      </button>
    </div>
  );
};

export default MiniPaginationControl;
