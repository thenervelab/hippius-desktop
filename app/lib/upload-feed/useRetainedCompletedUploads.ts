"use client";

import { useMemo, useRef } from "react";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { FileProgress } from "@/app/lib/types/syncSnapshot";
import {
  dedupKey,
  snapshotToItem,
  type UploadFeedItem,
} from "./mergeUploadFeed";

/** Backstop so a never-confirmed key can't grow the cache unbounded. Far above
 *  any realistic count of uploads awaiting a server refetch. */
const MAX_RETAINED = 100;

/**
 * Retain just-completed uploads across merges so the upload feed doesn't drop a
 * finished file in the gap between it leaving `snapshot.files` and the debounced
 * server refetch (`get_recent_uploads`) landing — the "appear then vanish" /
 * "completed file never shows" report.
 *
 * A completed upload is captured ONCE (with a stable `createdAt` — `FileProgress`
 * has no timestamp, so re-mapping it every ~4Hz merge would read "Just now"
 * forever) and retained until the server list confirms it by dedup key, at which
 * point the server row (real upload time) takes over. Eviction is reliable only
 * because both sides of the key run through the same path normalization in
 * {@link dedupKey}; a key that never matched the server would otherwise leak,
 * which the `MAX_RETAINED` backstop bounds.
 *
 * The cache is a ref mutated inside `useMemo` (a memoization cache keyed on the
 * inputs): capture/evict are idempotent, so a Strict-Mode double-invoke is safe.
 * Returns a fresh array only when the inputs change.
 */
export function useRetainedCompletedUploads(
  snapshotFiles: FileProgress[],
  recentUploads: FormattedUserFile[],
): UploadFeedItem[] {
  const cacheRef = useRef<Map<string, UploadFeedItem>>(new Map());

  return useMemo(() => {
    const cache = cacheRef.current;
    const serverKeys = new Set(recentUploads.map((f) => dedupKey(f)));

    for (const fp of snapshotFiles) {
      if (fp.action !== "upload") continue;
      const key = dedupKey({
        label: fp.label,
        actualFileName: fp.path,
        name: fp.fileName,
      });
      if (fp.status === "completed") {
        // Capture once, with the timestamp `snapshotToItem` stamps now.
        if (!serverKeys.has(key) && !cache.has(key)) {
          cache.set(key, snapshotToItem(fp));
        }
      } else {
        // Back in flight (re-upload / retry) — drop any stale retained copy so
        // the live in-flight row in mergeUploadFeed represents it instead.
        cache.delete(key);
      }
    }

    // Evict anything the server now confirms; its authoritative row takes over.
    for (const key of [...cache.keys()]) {
      if (serverKeys.has(key)) cache.delete(key);
    }

    // Bound memory: oldest-first eviction (Map preserves insertion order).
    while (cache.size > MAX_RETAINED) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }

    return [...cache.values()];
  }, [snapshotFiles, recentUploads]);
}

export default useRetainedCompletedUploads;
