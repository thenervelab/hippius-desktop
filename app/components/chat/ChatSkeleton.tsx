"use client";

import Skeleton from "@/components/ui/skeleton";

/**
 * Layout-stable placeholder for the chat shell while the session is read
 * and the client connects: a room-list rail and a timeline column.
 */
export default function ChatSkeleton() {
  return (
    <div
      className="flex h-full min-h-[480px] w-full overflow-hidden bg-white dark:bg-black-300"
      aria-busy="true"
      aria-label="Loading chat"
    >
      <div className="hidden w-64 shrink-0 flex-col gap-3 border-r border-grey-80 p-4 dark:border-black-300 md:flex">
        <Skeleton height="1.5rem" width="60%" />
        <div className="mt-2 flex flex-col gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} height="1.25rem" width={`${70 + ((i * 13) % 30)}%`} />
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-grey-80 px-5 py-4 dark:border-black-300">
          <Skeleton variant="circle" width="2rem" height="2rem" />
          <Skeleton height="1.25rem" width="30%" />
        </div>
        <div className="flex flex-1 flex-col justify-end gap-4 p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3">
              <Skeleton variant="circle" width="2.25rem" height="2.25rem" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton height="0.875rem" width="20%" />
                <Skeleton height="0.875rem" width={`${45 + ((i * 17) % 40)}%`} />
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-grey-80 p-4 dark:border-black-300">
          <Skeleton height="2.75rem" />
        </div>
      </div>
    </div>
  );
}
