"use client";

import React from "react";
import { X } from "lucide-react";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { shouldShowMoveHint } from "@/app/lib/drive-move/moveLogic";
import { useDriveMove } from "./DriveMoveProvider";

/**
 * The one-time tip that rows can be dragged onto folders. Shown in a
 * drive folder view with a folder and something to put in it, until it is
 * dismissed or the first move completes; never again after either.
 */
export default function MoveHint({ rows }: { rows: readonly FormattedUserFile[] }) {
  const move = useDriveMove();
  if (!move || move.target.readOnlyReason || move.hintSeen !== false) return null;
  if (!shouldShowMoveHint(rows, false)) return null;
  return (
    <div className="flex justify-center px-3 pb-2">
      <div
        role="note"
        className="inline-flex max-w-full items-center gap-2 rounded-full border border-grey-80 bg-white py-1 pl-3 pr-1 text-xs font-medium text-grey-40 dark:border-black-300 dark:bg-black-500 dark:text-grey-dark-600"
      >
        <span className="truncate">Drag files onto a folder to move them</span>
        <button
          type="button"
          onClick={move.dismissHint}
          aria-label="Dismiss"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-grey-90 dark:hover:bg-white/10"
        >
          <X className="size-3" aria-hidden />
        </button>
      </div>
    </div>
  );
}
