"use client";

import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";

import { snapshotAtom } from "./useSyncSnapshot";
import type { FileProgress } from "../types/syncSnapshot";
import { normalizeRelPath } from "../utils/relPath";

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

/** Composite map built once per snapshot so each row is an O(1) lookup. */
export type LiveProgressIndex = Map<string, LiveFileProgress>;

function pathKey(label: string | undefined, path: string): string {
  return label === undefined ? `p\0${path}` : `p\0${label}\0${path}`;
}

function nameKey(label: string | undefined, name: string): string {
  return label === undefined ? `n\0${name}` : `n\0${label}\0${name}`;
}

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
 * Resolve the snapshot row for a file row's key.
 *
 * `path` is the unique sync-root-relative identity, so it is matched first
 * (normalized, since the snapshot side can carry a leading slash the server
 * side trims). The basename fallback exists for rows that only know their
 * display name, but it binds ONLY on a unique match: two in-flight files
 * sharing a basename in different folders previously made a row latch onto the
 * wrong file's progress (and look "stuck" because completion landed on the
 * sibling). 0 or >1 matches now yield no live progress — a blank badge is
 * correct, another file's percent is not. `label` scopes both passes when known
 * so same-path-different-drive can't collide.
 */
export function findLiveFileMatch(
  files: FileProgress[],
  key: string,
  label?: string,
): FileProgress | null {
  const scoped =
    label === undefined ? files : files.filter((f) => f.label === label);
  const target = normalizeRelPath(key);
  const byPath = scoped.filter((f) => normalizeRelPath(f.path) === target);
  if (byPath.length === 1) return byPath[0];
  if (byPath.length > 1) return null;
  const byName = scoped.filter((f) => f.fileName === key);
  return byName.length === 1 ? byName[0] : null;
}

function toLiveProgress(file: FileProgress): LiveFileProgress {
  const status = deriveLiveStatus(file);
  if (!status) return EMPTY;
  const bucketed =
    Math.floor(file.progressPercent / PROGRESS_BUCKET) * PROGRESS_BUCKET;
  return { status, progressPercent: bucketed };
}

function pushBucket(
  buckets: Map<string, FileProgress[]>,
  key: string,
  file: FileProgress,
): void {
  const existing = buckets.get(key);
  if (existing) {
    existing.push(file);
  } else {
    buckets.set(key, [file]);
  }
}

/**
 * Scan the snapshot file list once and index every unambiguous
 * path / basename lookup `findLiveFileMatch` would accept.
 *
 * Ambiguous buckets (same basename in two folders, same path in two
 * drives when unscoped) are omitted — a blank badge is correct, another
 * file's percent is not.
 */
export function buildLiveProgressIndex(
  files: FileProgress[],
): LiveProgressIndex {
  const byPathAll = new Map<string, FileProgress[]>();
  const byPathLabel = new Map<string, FileProgress[]>();
  const byNameAll = new Map<string, FileProgress[]>();
  const byNameLabel = new Map<string, FileProgress[]>();

  for (const file of files) {
    const path = normalizeRelPath(file.path);
    pushBucket(byPathAll, path, file);
    pushBucket(byPathLabel, `${file.label}\0${path}`, file);
    pushBucket(byNameAll, file.fileName, file);
    pushBucket(byNameLabel, `${file.label}\0${file.fileName}`, file);
  }

  const index: LiveProgressIndex = new Map();

  const putIfUnique = (key: string, bucket: FileProgress[]) => {
    if (bucket.length !== 1) return;
    const only = bucket[0];
    if (only === undefined) return;
    const progress = toLiveProgress(only);
    if (progress.status === null) return;
    index.set(key, progress);
  };

  for (const [path, bucket] of byPathAll) {
    putIfUnique(pathKey(undefined, path), bucket);
  }
  for (const [composite, bucket] of byPathLabel) {
    const sep = composite.indexOf("\0");
    const label = composite.slice(0, sep);
    const path = composite.slice(sep + 1);
    putIfUnique(pathKey(label, path), bucket);
  }
  for (const [name, bucket] of byNameAll) {
    putIfUnique(nameKey(undefined, name), bucket);
  }
  for (const [composite, bucket] of byNameLabel) {
    const sep = composite.indexOf("\0");
    const label = composite.slice(0, sep);
    const name = composite.slice(sep + 1);
    putIfUnique(nameKey(label, name), bucket);
  }

  return index;
}

export function liveProgressIndexEqual(
  a: LiveProgressIndex,
  b: LiveProgressIndex,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (
      other === undefined ||
      other.status !== value.status ||
      other.progressPercent !== value.progressPercent
    ) {
      return false;
    }
  }
  return true;
}

export function lookupLiveProgress(
  index: LiveProgressIndex,
  actualName: string | undefined,
  fileName: string,
  label?: string,
): LiveFileProgress {
  const key = actualName || fileName;
  const path = normalizeRelPath(key);
  if (label !== undefined) {
    return (
      index.get(pathKey(label, path)) ??
      index.get(nameKey(label, key)) ??
      EMPTY
    );
  }
  return index.get(pathKey(undefined, path)) ?? index.get(nameKey(undefined, key)) ?? EMPTY;
}

/**
 * One index per snapshot (scan the file list once), then each row
 * selects only its own bucketed status/percent so a 4 Hz tick on
 * another file does not re-render this row.
 */
export const liveProgressIndexAtom = selectAtom(
  snapshotAtom,
  (snapshot) => buildLiveProgressIndex(snapshot.files),
  liveProgressIndexEqual,
);

/**
 * Subscribes to the sync snapshot and returns the live progress entry
 * matching this file, or `EMPTY` if the file is not currently in flight.
 *
 * Each row creates its own derived atom keyed by `actualName + fileName +
 * label` with a custom equality function — the row only re-renders when its own
 * status or its bucketed percent changes, not on every snapshot tick.
 */
export function useFileLiveProgress(
  actualName: string | undefined,
  fileName: string,
  label?: string,
): LiveFileProgress {
  const derivedAtom = useMemo(
    () =>
      selectAtom(
        liveProgressIndexAtom,
        (index): LiveFileProgress =>
          lookupLiveProgress(index, actualName, fileName, label),
        (a, b) =>
          a.status === b.status && a.progressPercent === b.progressPercent,
      ),
    [actualName, fileName, label],
  );

  return useAtomValue(derivedAtom);
}
