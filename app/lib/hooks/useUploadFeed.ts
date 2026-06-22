"use client";

import { useEffect, useMemo } from "react";
import { useAtomValue } from "jotai";
import useRecentUploads from "@/app/lib/hooks/useRecentUploads";
import { snapshotAtom } from "@/app/lib/hooks/useSyncSnapshot";
import {
  mergeUploadFeed,
  type UploadFeedItem,
} from "@/app/lib/upload-feed/mergeUploadFeed";
import { useRetainedCompletedUploads } from "@/app/lib/upload-feed/useRetainedCompletedUploads";

/**
 * Main-window upload feed: the account-wide "last uploads" (server) overlaid
 * with this device's live sync progress, ordered uploading → failed →
 * completed and capped to `limit`. Backs the Recent Files section.
 *
 * `useRecentUploads` is the persistent completed list (react-query cached);
 * `snapshotAtom` is the live in-progress/failed feed (event-driven, mounted
 * once by `useSyncSnapshot`). They are joined by the pure `mergeUploadFeed`.
 * A finished upload fires `sync_files_completed_changed`, which we use to
 * refetch the server list so the just-completed file moves from the live
 * "uploading" overlay to an authoritative completed row.
 */
export function useUploadFeed(limit: number) {
  const { data, isLoading, isFetching, refetch } = useRecentUploads(limit);
  const snapshot = useAtomValue(snapshotAtom);

  useEffect(() => {
    const handler = () => {
      void refetch();
    };
    window.addEventListener("sync_files_completed_changed", handler);
    return () =>
      window.removeEventListener("sync_files_completed_changed", handler);
  }, [refetch]);

  const retainedCompleted = useRetainedCompletedUploads(
    snapshot.files,
    data ?? [],
  );

  const files: UploadFeedItem[] = useMemo(
    () =>
      mergeUploadFeed({
        recentUploads: data ?? [],
        snapshotFiles: snapshot.files,
        retainedCompleted,
        limit,
      }),
    [data, snapshot.files, retainedCompleted, limit],
  );

  return { data: files, isLoading, isFetching, refetch };
}

export default useUploadFeed;
