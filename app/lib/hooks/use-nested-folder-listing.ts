"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

interface SyncFileEntry {
  name: string;
  is_folder: boolean;
  size: number;
  modified: number | null;
  arion_hash?: string;
  arion_cid?: string;
  sync_status?: string;
}

interface GroupedListing {
  folders: SyncFileEntry[];
  files: SyncFileEntry[];
  pendingBackfill: boolean;
}

interface UseNestedFolderListingOptions {
  /** Polkadot address — call is disabled until truthy. */
  accountId: string | null | undefined;
  /** Sync root path. Empty/null disables the call. */
  syncPath: string | null | undefined;
  /**
   * Relative subfolder path inside the sync root (e.g. "Photos/2024").
   * Pass `null` for the root listing of the sync folder.
   */
  subfolder: string | null | undefined;
  /** Drive label — needed by Rust to merge the rel-path index overlay. */
  label: string | null | undefined;
  /** When this changes, the listing is re-fetched without showing a full loader. */
  refreshKey?: number;
  /** Skip the fetch entirely (e.g. when not in nested mode). */
  enabled: boolean;
}

interface UseNestedFolderListingResult {
  /** Folder rows + file rows, folders-first, mapped to FormattedUserFile. */
  data: FormattedUserFile[];
  /** True only on the initial load for the current (syncPath, subfolder) pair. */
  isLoading: boolean;
  /** True for background refreshes triggered by `refreshKey`. */
  isRefreshing: boolean;
  /** Manually trigger a background refresh. */
  refresh: () => void;
  error: unknown;
}

/**
 * Fetches a single nested folder's contents from the Rust sync engine.
 *
 * Mirrors the data path the old FolderView used (now removed): one IPC call
 * to `list_sync_folder_grouped`, mapped into `FormattedUserFile[]` so the
 * existing DriveContent / FilesTable / CardView components can render it
 * without changes.
 */
export function useNestedFolderListing({
  accountId,
  syncPath,
  subfolder,
  label,
  refreshKey,
  enabled,
}: UseNestedFolderListingOptions): UseNestedFolderListingResult {
  const [data, setData] = useState<FormattedUserFile[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [manualRefreshKey, setManualRefreshKey] = useState(0);
  // The (syncPath, subfolder) tuple that produced the current `data`. While
  // it disagrees with the requested tuple, we surface the initial loader
  // instead of stale rows from a previous folder.
  const lastLoadedKeyRef = useRef<string | null>(null);
  // Bumped after every settled (success or error) fetch so the render-time
  // `isLoading` derivation re-evaluates against the new `lastLoadedKeyRef`.
  // A bare ref mutation wouldn't trigger a re-render on its own.
  const [, forceRender] = useState(0);

  const refresh = useCallback(() => {
    setManualRefreshKey((prev) => prev + 1);
  }, []);

  // Composite request key — null when the hook is disabled or the
  // underlying inputs aren't ready yet. Compared against
  // `lastLoadedKeyRef` to decide whether the data we hold matches the
  // currently-requested folder.
  const requestKey =
    enabled && accountId && syncPath
      ? `${syncPath}::${subfolder ?? ""}`
      : null;

  // Synchronous loading flag — true the moment we know we're "supposed to
  // be loading" but haven't successfully loaded the current request yet.
  // This covers three transitional states that all otherwise render the
  // "no entries" empty state by mistake while the URL is mid-flip:
  //
  //   1. `enabled` just flipped true but `syncPath` / `accountId` are still
  //      null because the parent useMemo / atom read hasn't settled yet
  //      (requestKey === null while enabled is true).
  //   2. requestKey is populated but doesn't match `lastLoadedKeyRef` —
  //      i.e. a different folder is requested than the one we last loaded.
  //   3. The effect hasn't run yet on the first render after enable.
  //
  // Deriving (rather than `useState`-ing) sidesteps the
  // "useState(false) → first render → effect sets true → re-render" race
  // that caused the brief empty-state flash on navigation.
  const isLoading =
    enabled && (requestKey === null || lastLoadedKeyRef.current !== requestKey);

  useEffect(() => {
    if (!enabled || !accountId || !syncPath) {
      setData([]);
      setIsRefreshing(false);
      setError(null);
      lastLoadedKeyRef.current = null;
      return;
    }

    let cancelled = false;
    const effectRequestKey = `${syncPath}::${subfolder ?? ""}`;
    const isInitialLoad = lastLoadedKeyRef.current !== effectRequestKey;
    if (!isInitialLoad) {
      // Same folder, triggered by `refreshKey` or `manualRefreshKey` —
      // keep current rows visible and just flag the spinner.
      setIsRefreshing(true);
    }

    (async () => {
      try {
        const listing = await invoke<GroupedListing>(
          "list_sync_folder_grouped",
          {
            accountId,
            syncPath,
            subfolder: subfolder || null,
            label: label || null,
          },
        );

        if (cancelled) return;

        const entries: SyncFileEntry[] = [
          ...listing.folders,
          ...listing.files,
        ];

        const formatted: FormattedUserFile[] = entries.map((entry) => {
          const modifiedMs = (entry.modified ?? 0) * 1000;
          const filePath = subfolder
            ? `${syncPath}/${subfolder}/${entry.name}`
            : `${syncPath}/${entry.name}`;
          const actualFileName =
            subfolder && !entry.is_folder
              ? `${subfolder}/${entry.name}`
              : entry.name;
          return {
            name: entry.name,
            actualFileName,
            size: entry.size,
            createdAt: modifiedMs,
            arionHash: entry.arion_hash || "",
            arionCid: entry.arion_cid || "",
            source: filePath,
            minerIds: [],
            isAssigned: entry.is_folder || entry.sync_status === "synced",
            lastChargedAt: modifiedMs,
            isFolder: entry.is_folder,
            type: "private",
            isErasureCoded: false,
            mainReqHash: "",
            label: label || undefined,
            syncStatus:
              (entry.sync_status as FormattedUserFile["syncStatus"]) ??
              "unknown",
          };
        });

        setData(formatted);
        lastLoadedKeyRef.current = effectRequestKey;
        setError(null);
      } catch (err) {
        if (cancelled) return;
        console.error("[useNestedFolderListing] fetch failed:", err);
        setError(err);
        // Mark the key as "we tried" so the derived `isLoading` flips back
        // to false even on failure — otherwise the spinner would hang
        // forever and the user would never see the empty / error state.
        lastLoadedKeyRef.current = effectRequestKey;
      } finally {
        if (!cancelled) {
          setIsRefreshing(false);
          // Trigger a re-render so the render-time `isLoading` derivation
          // re-reads the updated `lastLoadedKeyRef`.
          forceRender((tick) => tick + 1);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    accountId,
    syncPath,
    subfolder,
    label,
    refreshKey,
    manualRefreshKey,
    enabled,
  ]);

  return { data, isLoading, isRefreshing, refresh, error };
}

export default useNestedFolderListing;
