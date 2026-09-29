"use client";

import { useQuery } from "@tanstack/react-query";

import {
  folderGrantStats,
  type FolderGrantStats,
  type MyFolderGrantInfo,
} from "@/app/lib/tauri/sharedDrives";

export const FOLDER_GRANT_STATS_QUERY_KEY = "folder-grant-stats";

export type FolderGrantStatsState =
  | { kind: "loading" }
  | { kind: "ready"; stats: FolderGrantStats }
  | { kind: "failed" };

/**
 * A shared folder's own size and file count, for its row in "Shared with
 * me". One request per folder, keyed by owner, drive and folder, the only
 * thing that names one granted folder. A failure is settled ("failed"), so
 * the row shows a dash rather than a skeleton that never resolves.
 */
export function useFolderGrantStats(
  grant: Pick<MyFolderGrantInfo, "ownerSs58" | "folderHash" | "pathPrefix">,
): FolderGrantStatsState {
  const { data, isError } = useQuery({
    queryKey: [FOLDER_GRANT_STATS_QUERY_KEY, grant.ownerSs58, grant.folderHash, grant.pathPrefix],
    queryFn: () => folderGrantStats(grant.ownerSs58, grant.folderHash, grant.pathPrefix),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  if (data) return { kind: "ready", stats: data };
  if (isError) return { kind: "failed" };
  return { kind: "loading" };
}
