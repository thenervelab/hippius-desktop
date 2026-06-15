"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";

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
        "inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[#e4e4e7] bg-white",
        "px-2 shadow-[0px_2px_5px_0px_rgba(0,0,0,0.05)]",
        "dark:border-black-300 dark:bg-white/[0.02] dark:shadow-[0px_0px_0px_1px_black]",
        className,
      )}
    >
      <button
        type="button"
        onClick={onPrev}
        disabled={currentPage <= 1}
        className={cn(
          "flex size-5 items-center justify-center rounded transition-colors",
          currentPage <= 1 ? "opacity-40" : "hover:bg-black/5 dark:hover:bg-white/10",
        )}
      >
        <ChevronLeft className="size-3.5 text-[#7d7d7d] dark:text-grey-dark-700" />
      </button>

      <span className="whitespace-nowrap font-geist text-[14px] font-medium uppercase tabular-nums tracking-[-0.28px] text-[#7d7d7d] dark:text-grey-dark-700">
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
      >
        <ChevronRight className="size-3.5 text-[#7d7d7d] dark:text-grey-dark-700" />
      </button>
    </div>
  );
};
