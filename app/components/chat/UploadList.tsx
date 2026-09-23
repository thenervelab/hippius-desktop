"use client";

import { AlertCircle, X } from "lucide-react";

import { formatFileSize } from "@/lib/chat/attachments";
import { cn } from "@/lib/utils";

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  loaded: number;
  status: "uploading" | "failed";
  error?: string;
  abort: AbortController;
}

interface UploadListProps {
  items: UploadItem[];
  onCancel: (id: string) => void;
}

/** In-flight uploads shown inside the composer, with progress and cancel. */
export default function UploadList({ items, onCancel }: UploadListProps) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2 px-3 pb-1" aria-label="Uploads">
      {items.map((item) => {
        const pct = item.size ? Math.min(100, Math.round((item.loaded / item.size) * 100)) : 0;
        return (
          <li
            key={item.id}
            className={cn(
              "relative flex w-56 items-center gap-2 overflow-hidden rounded-md border px-2 py-1.5 text-xs",
              item.status === "failed"
                ? "border-error-50/50 bg-error-50/5 dark:border-error-50/50 dark:bg-error-50/10"
                : "border-grey-80 bg-grey-light-600 dark:border-black-500 dark:bg-black-primary-bg",
            )}
          >
            {item.status === "uploading" ? (
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary-50/30 dark:bg-primary-40/30" aria-hidden>
                <span className="block h-full bg-primary-50 transition-[width] dark:bg-primary-40" style={{ width: `${pct}%` }} />
              </span>
            ) : null}
            {item.status === "failed" ? <AlertCircle className="size-3.5 shrink-0 text-error-50 dark:text-error-50" aria-hidden /> : null}
            <div className="min-w-0 flex-1">
              <p className="truncate text-grey-10 dark:text-grey-light-100">{item.name}</p>
              <p className="truncate text-grey-60 dark:text-grey-dark-700">
                {item.status === "failed" ? item.error ?? "Upload failed" : `${formatFileSize(item.loaded)} / ${formatFileSize(item.size)} · ${pct}%`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onCancel(item.id)}
              aria-label={item.status === "failed" ? `Dismiss ${item.name}` : `Cancel upload of ${item.name}`}
              className="text-grey-60 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-grey-light-100"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
