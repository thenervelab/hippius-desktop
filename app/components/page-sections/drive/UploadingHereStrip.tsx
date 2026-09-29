"use client";

import { useAtomValue } from "jotai";
import { AlertCircle, Loader2 } from "lucide-react";
import { remoteUploadsAtom } from "@/app/lib/remote-upload/remoteUploadFeed";
import { rowPercent, uploadsInFolder } from "./uploadingHere";

/** At most this many rows; the sync widget has the full list. */
const MAX_ROWS = 3;

/**
 * "Uploading here": files on their way into this folder that are not in its
 * listing yet, with their progress. Renders nothing when there are none.
 */
export default function UploadingHereStrip({ label, subPath }: { label: string | null; subPath: string | null }) {
  const rows = uploadsInFolder(useAtomValue(remoteUploadsAtom), label, subPath);
  if (rows.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-3 flex flex-col gap-1.5 rounded-[8px] border border-grey-80 bg-grey-light-200 px-3 py-2 dark:border-black-300 dark:bg-black-500"
    >
      {rows.slice(0, MAX_ROWS).map((row) => {
        const failed = row.status === "error";
        const percent = rowPercent(row);
        return (
          <div key={row.path} className="flex min-w-0 items-center gap-2.5 text-[13px]">
            {failed ? (
              <AlertCircle className="size-4 shrink-0 text-error-50" />
            ) : (
              <Loader2 className="size-4 shrink-0 animate-spin text-primary-50" />
            )}
            <span className="min-w-0 flex-1 truncate text-grey-10 dark:text-grey-light-100" title={row.fileName}>
              {failed ? `Couldn't upload ${row.fileName}` : `Uploading ${row.fileName}`}
            </span>
            {!failed && (
              <span className="flex w-28 shrink-0 items-center gap-2 max-sm:w-16">
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-grey-80 dark:bg-black-300">
                  <span
                    className={`block h-full rounded-full bg-primary-50 transition-[width] duration-300 ${percent === null ? "w-1/4 animate-pulse" : ""}`}
                    style={percent === null ? undefined : { width: `${Math.max(4, percent)}%` }}
                  />
                </span>
                <span className="w-8 text-right text-[12px] tabular-nums text-grey-50 max-sm:hidden dark:text-grey-dark-600">
                  {percent === null ? "" : `${percent}%`}
                </span>
              </span>
            )}
          </div>
        );
      })}
      {rows.length > MAX_ROWS && (
        <p className="text-[12px] text-grey-50 dark:text-grey-dark-600">and {rows.length - MAX_ROWS} more</p>
      )}
    </div>
  );
}
