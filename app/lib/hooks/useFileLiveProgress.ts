"use client";

import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";

import { snapshotAtom } from "./useSyncSnapshot";
import type { FileProgress } from "../types/syncSnapshot";

export type LiveFileStatus =
  | "pending"
  | "uploading"
  | "downloading"
  | "failed"
  | "synced";

export interface LiveFileProgress {
  status: LiveFileStatus | null;
  progressPercent: number | null;
}

const EMPTY: LiveFileProgress = { status: null, progressPercent: null };

function deriveLiveStatus(file: FileProgress): LiveFileStatus | null {
  if (file.status === "error") return "failed";
  if (file.status === "completed") return "synced";
  if (file.status === "pending") return "pending";
  // inProgress / encrypting / decrypting all map to the active direction
  // of the surrounding action, so encrypting an upload still reads as
  // "uploading" to the user (it's the same pipeline).
  if (file.action === "download") return "downloading";
  return "uploading";
}

// Bucket the percent to 5% steps so re-renders only fire on visible
// progress changes. Without this the row would re-render on every 250ms
// snapshot tick during a fast transfer.
const PROGRESS_BUCKET = 5;

/**
 * Subscribes to the sync snapshot and returns the live progress entry
 * matching this file, or `EMPTY` if the file is not currently in flight.
 *
 * Each row creates its own derived atom keyed by `actualName + fileName`
 * with a custom equality function — the row only re-renders when its own
 * status or its bucketed percent changes, not on every snapshot tick.
 */
export function useFileLiveProgress(
  actualName: string | undefined,
  fileName: string,
): LiveFileProgress {
  const derivedAtom = useMemo(() => {
    const key = actualName || fileName;
    return selectAtom(
      snapshotAtom,
      (snapshot): LiveFileProgress => {
        const match = snapshot.files.find(
          (f) => f.path === key || f.fileName === key,
        );
        if (!match) return EMPTY;
        const status = deriveLiveStatus(match);
        if (!status) return EMPTY;
        const bucketed =
          Math.floor(match.progressPercent / PROGRESS_BUCKET) *
          PROGRESS_BUCKET;
        return { status, progressPercent: bucketed };
      },
      (a, b) =>
        a.status === b.status && a.progressPercent === b.progressPercent,
    );
  }, [actualName, fileName]);

  return useAtomValue(derivedAtom);
}
