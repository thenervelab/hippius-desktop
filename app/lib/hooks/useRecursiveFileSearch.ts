import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { FileFilterRequest } from "@/app/lib/hooks/useFilteredFiles";

/**
 * Cross-folder file search via the Rust `search_user_files_recursive`
 * IPC. The console-equivalent path: when the user types into search or
 * picks a filter, the result spans every nested folder under the active
 * drive (or under `subfolder` when set), not just the in-memory list at
 * the current level.
 *
 * Why a custom hook instead of `useQuery`: same rationale as
 * [`useFilteredFiles`] — the inputs change on every keystroke and we
 * want to debounce + cancel stale calls. Keeping both hooks symmetric
 * (debounce, latest-call guard, `isFiltering` flag) lets DriveContainer
 * swap between them without touching its loading-state derivation.
 */
export interface UseRecursiveFileSearchOptions {
    accountId: string | null | undefined;
    /** Drive label (sync_paths.label) for the active drive. Required. */
    label: string | null | undefined;
    /**
     * Sync-root-relative subfolder to scope the search to (e.g.
     * "Photos/2024"). When unset / empty, the search spans the whole
     * drive. Mirrors the console's `folder_hash` scope.
     */
    subfolder?: string | null;
    /** Filter criteria mirroring `FileFilterRequest`. */
    criteria: FileFilterRequest;
    /** Bumping this forces a refetch (used by the refresh button). */
    refreshKey?: number;
    /** Debounce window for the IPC call. Defaults to 200 ms. */
    debounceMs?: number;
    /** When false, the hook never fires and returns an empty list. */
    enabled?: boolean;
}

export interface UseRecursiveFileSearchResult {
    data: FormattedUserFile[];
    /** True between input change and IPC settlement. */
    isFetching: boolean;
}

function hasAnyCriteria(criteria: FileFilterRequest): boolean {
    return Boolean(
        criteria.searchTerm?.trim() ||
            (criteria.fileExtensions && criteria.fileExtensions.length > 0) ||
            // `dateRange` is `{from, to}` — `from` is the required field
            // (the picker can't commit a range without a start date), so
            // its presence is sufficient to say "filter active".
            (criteria.dateRange && criteria.dateRange.from) ||
            (criteria.fileSizes && criteria.fileSizes.length > 0),
    );
}

export function useRecursiveFileSearch(
    options: UseRecursiveFileSearchOptions,
): UseRecursiveFileSearchResult {
    const {
        accountId,
        label,
        subfolder,
        criteria,
        refreshKey,
        debounceMs = 200,
        enabled = true,
    } = options;

    const [result, setResult] = useState<FormattedUserFile[]>([]);
    const latestCallIdRef = useRef(0);

    const shouldFire =
        enabled &&
        Boolean(accountId) &&
        Boolean(label) &&
        hasAnyCriteria(criteria);

    // Build the inputs object that drives both the effect dep array and
    // the render-time `isFetching` derivation. Mirrors `useFilteredFiles`.
    const currentInputs = useMemo(
        () => ({
            accountId,
            label,
            subfolder,
            searchTerm: criteria.searchTerm,
            fileExtensions: criteria.fileExtensions,
            dateFilter: criteria.dateRange,
            fileSizes: criteria.fileSizes,
            folderTab: criteria.folderTab,
            refreshKey,
        }),
        [
            accountId,
            label,
            subfolder,
            criteria.searchTerm,
            criteria.fileExtensions,
            criteria.dateRange,
            criteria.fileSizes,
            criteria.folderTab,
            refreshKey,
        ],
    );
    const loadedInputsRef = useRef<typeof currentInputs | null>(null);
    const [, forceRender] = useState(0);

    useEffect(() => {
        if (!shouldFire) {
            // No criteria → no recursive search. Reset to empty so the
            // caller doesn't accidentally render stale matches from a
            // previous filter session.
            setResult([]);
            loadedInputsRef.current = currentInputs;
            forceRender((tick) => tick + 1);
            return;
        }

        const callId = ++latestCallIdRef.current;
        const handle = setTimeout(async () => {
            try {
                const filtered = await invoke<FormattedUserFile[]>(
                    "search_user_files_recursive",
                    {
                        accountId,
                        label,
                        subfolder: subfolder && subfolder.length > 0 ? subfolder : null,
                        filters: {
                            searchTerm: criteria.searchTerm ?? null,
                            fileExtensions: criteria.fileExtensions ?? null,
                            dateRange: criteria.dateRange ?? null,
                            fileSizes: criteria.fileSizes ?? null,
                            // Folder tab not applicable — already scoped by label.
                            folderTab: null,
                        },
                    },
                );
                if (callId === latestCallIdRef.current) {
                    setResult(filtered);
                    loadedInputsRef.current = currentInputs;
                    forceRender((tick) => tick + 1);
                }
            } catch (err) {
                console.error("search_user_files_recursive failed:", err);
                if (callId === latestCallIdRef.current) {
                    setResult([]);
                    loadedInputsRef.current = currentInputs;
                    forceRender((tick) => tick + 1);
                }
            }
        }, debounceMs);

        return () => clearTimeout(handle);
    }, [
        shouldFire,
        accountId,
        label,
        subfolder,
        criteria.searchTerm,
        criteria.fileExtensions,
        criteria.dateRange,
        criteria.fileSizes,
        criteria.folderTab,
        refreshKey,
        debounceMs,
        currentInputs,
    ]);

    const isFetching = shouldFire && loadedInputsRef.current !== currentInputs;
    return { data: result, isFetching };
}

export default useRecursiveFileSearch;
