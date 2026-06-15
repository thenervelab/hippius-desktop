"use client";

import { useAtomValue } from "jotai";
import { migrationProgressAtom } from "@/lib/global-atoms/migrationAtoms";
import { ProgressBar, Icons } from "@/components/ui";

function formatCount(n: number): string {
  return n.toLocaleString();
}

export default function MigrationBanner() {
  const progress = useAtomValue(migrationProgressAtom);

  if (!progress.active) return null;

  const percentage =
    progress.total > 0
      ? Math.round((progress.completed / progress.total) * 100)
      : 0;

  return (
    <div className="relative flex items-center gap-3 overflow-hidden rounded-xl border border-primary-80 bg-gradient-to-r from-primary-50/[0.10] to-primary-50/[0.02] px-4 py-3.5 mt-2 dark:border-primary-50/50 dark:from-primary-50/[0.18] dark:to-primary-50/[0.05]">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-50/10 dark:bg-primary-50/25">
        <Icons.Loader className="size-4 text-primary-50 dark:text-primary-40 animate-spin" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-grey-10 dark:text-white">
            Migrating files…
          </span>
          <span className="shrink-0 text-xs font-medium tabular-nums text-grey-50 dark:text-grey-dark-700">
            {formatCount(progress.completed)} / {formatCount(progress.total)}
            <span className="ml-1.5 text-primary-50 dark:text-primary-40">
              {percentage}%
            </span>
          </span>
        </div>
        <ProgressBar value={percentage} className="h-1.5" />
      </div>
    </div>
  );
}
