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
  // "pending" is only honored while the transfer hasn't moved any bytes
  // yet. The engine parks a file back on "pending" between chunk batches
  // and retries (scheduling noise), and honoring that mid-transfer flapped
  // the badge ring↔pill — remounting the ring's tooltip (closing it under
  // the user's cursor) and making the percent appear to jump when the ring
  // came back. Once bytes have moved, the file stays in its transfer state
  // until it completes or errors.
  if (
    file.status === "pending" &&
    file.progressPercent <= 0 &&
    file.bytesTransferred <= 0
  ) {
    return "pending";
  }
  // inProgress / encrypting / decrypting all map to the active direction
  // of the surrounding action, so encrypting an upload still reads as
  // "uploading" to the user (it's the same pipeline).
  if (file.action === "download") return "downloading";
  return "uploading";
}

// Bucket the percent to whole-percent steps so re-renders only fire on
// visible progress changes, not on every 250ms snapshot tick during a fast
// transfer. Only the in-flight rows subscribe at this granularity, so 1%
// is cheap — a coarser 5% bucket made big-file progress feel slow/jumpy
// (one visual tick every ~8MB).
const PROGRESS_BUCKET = 1;

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
