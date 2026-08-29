"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Floating "3 / 16" control shared by the slide and page based previews. It
 * sits over the content the way Google Drive's pager does and never affects
 * layout, so a document and a deck read the same way.
 */
export default function PreviewPager({
  page,
  pageCount,
  onChange,
  label = "page",
  className,
}: {
  /** Zero-based current page. */
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  /** Noun used in the accessible labels ("slide", "page"). */
  label?: string;
  className?: string;
}) {
  if (pageCount <= 1) return null;

  const buttonClass = cn(
    "flex size-7 items-center justify-center rounded-full transition-colors",
    "text-grey-30 hover:bg-grey-light-700 hover:text-grey-10",
    "disabled:opacity-30 disabled:hover:bg-transparent",
    "dark:text-grey-light-300 dark:hover:bg-black-300 dark:hover:text-white",
  );

  return (
    <div
      className={cn(
        "pointer-events-auto flex h-9 items-center gap-1 rounded-full px-1.5",
        "border border-grey-dark-100 bg-white/95 backdrop-blur",
        "text-xs font-medium text-grey-30",
        "shadow-[0_4px_16px_rgba(0,0,0,0.16)]",
        "dark:border-black-300 dark:bg-black-primary-bg/95 dark:text-grey-light-300",
        className,
      )}
    >
      <button
        type="button"
        aria-label={`Previous ${label}`}
        disabled={page <= 0}
        onClick={() => onChange(page - 1)}
        className={buttonClass}
      >
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-14 select-none text-center tabular-nums">
        {page + 1} / {pageCount}
      </span>
      <button
        type="button"
        aria-label={`Next ${label}`}
        disabled={page >= pageCount - 1}
        onClick={() => onChange(page + 1)}
        className={buttonClass}
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}
