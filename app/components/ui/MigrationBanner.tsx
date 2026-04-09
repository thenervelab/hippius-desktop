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
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-primary-80 bg-primary-50/5 mt-2">
      <Icons.Loader className="size-4 text-primary-50 animate-spin shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium text-grey-10">
            Migrating files...
          </span>
          <span className="text-xs text-grey-50">
            {formatCount(progress.completed)} / {formatCount(progress.total)}
          </span>
        </div>
        <ProgressBar value={percentage} className="h-1.5" />
      </div>
      <span className="text-xs font-medium text-primary-50 shrink-0">
        {percentage}%
      </span>
    </div>
  );
}
