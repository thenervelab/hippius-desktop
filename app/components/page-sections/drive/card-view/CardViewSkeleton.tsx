"use client";

import React from "react";
import { cn } from "@/lib/utils";
import Skeleton from "@/components/ui/skeleton";

interface CardViewSkeletonProps {
  isRecentFiles?: boolean;
  cards?: number;
}

const SKELETON_BAR_CLASS =
  "rounded-full bg-grey-80 dark:bg-black-300 animate-pulse";

/**
 * Card-grid skeleton used while the FilesTable is rendered in card view
 * and the underlying data is still loading. Mirrors `card-view/index.tsx`:
 * same grid breakpoints, same per-card 220px height, same border/background
 * tokens — so the layout doesn't jump when real cards replace placeholders.
 */
const CardViewSkeleton: React.FC<CardViewSkeletonProps> = ({
  isRecentFiles = false,
  cards = 8,
}) => (
  <div className="flex flex-col gap-y-8 relative">
    <div
      className={cn(
        "w-full relative",
        isRecentFiles ? "min-h-[12.5rem]" : "min-h-[43.75rem]",
      )}
    >
      <div className="grid grid-cols-1 @sm:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4 gap-4">
        {Array.from({ length: cards }).map((_, index) => (
          <div
            key={`card-skeleton-${index}`}
            className="w-full relative border border-grey-dark-100 dark:border-black-300 rounded-[5px] overflow-hidden h-[220px] flex flex-col bg-white dark:bg-black-500"
          >
            {/* Header row — matches the icon + filename + action-menu row
                of FileCard (`px-2 pt-2 pb-1 h-9`). */}
            <div className="px-2 pt-2 pb-1 flex items-center justify-between gap-1 h-9 w-full shrink-0">
              <div className="flex items-center min-w-0 flex-1 gap-2">
                <Skeleton
                  height="1rem"
                  width="1rem"
                  className={cn(SKELETON_BAR_CLASS, "shrink-0 rounded")}
                />
                <Skeleton
                  height="0.75rem"
                  width="65%"
                  className={SKELETON_BAR_CLASS}
                />
              </div>
              <Skeleton
                height="1rem"
                width="1rem"
                className={cn(SKELETON_BAR_CLASS, "shrink-0 rounded")}
              />
            </div>

            {/* Body — matches the thumbnail/icon area of FileCard, divided
                from the header by a top border in the same color token. */}
            <div className="flex flex-1 min-h-0 items-center justify-center relative border-t border-grey-dark-100 dark:border-black-300 bg-white dark:bg-black-500">
              <Skeleton
                height="3.5rem"
                width="3.5rem"
                className={cn(
                  "rounded-lg bg-grey-80 dark:bg-black-300 animate-pulse",
                )}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

export default CardViewSkeleton;
