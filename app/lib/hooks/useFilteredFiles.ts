import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { FileTypes } from "@/lib/types/fileTypes";

/**
 * Shape of the filter criteria passed to the Rust `filter_file_entries`
 * IPC. Mirrors `FileFilterCriteria` in `src-tauri/src/sync/files.rs`
 * (all fields optional, camelCase via serde rename_all).
 */
export interface FileFilterRequest {
    searchTerm?: string;
    fileTypes?: FileTypes[];
    dateFilter?: string;
    fileSizes?: number[];
    folderTab?: string | null;
}

/**
 * Apply the Rust-side file filter to an in-memory list.
 *
 * Why this isn't a TanStack Query: the input is a large array the
 * frontend already has (from `useUserFiles`), not a refetchable query.
 * A plain `useEffect` with a debounce fits the shape better — we're
 * debouncing fast typing in the search box, not coordinating a network
 * fetch.
 *
 * `debounceMs` defaults to 150 ms, which is long enough that a typist
 * doesn't trigger an IPC on every keystroke but short enough that the
 * list still feels live. Non-search changes (checkbox toggles) apply
 * on the next microtask because the filter-state reference changes
 * immediately.
 */
export function useFilteredFiles<T extends FormattedUserFile>(
    files: T[],
    criteria: FileFilterRequest,
    debounceMs = 150,
): T[] {
    const [result, setResult] = useState<T[]>(files);
    // Track the latest invocation so an out-of-order late response can't
    // overwrite a newer one (user types quickly, older IPC resolves after).
    const latestCallIdRef = useRef(0);

    const isNoopCriteria =
        !criteria.searchTerm &&
        (!criteria.fileTypes || criteria.fileTypes.length === 0) &&
        !criteria.dateFilter &&
        (!criteria.fileSizes || criteria.fileSizes.length === 0) &&
        !criteria.folderTab;

    useEffect(() => {
        if (isNoopCriteria) {
            // Keep `result` in sync with `files` for the next render, but
            // the return value already short-circuits to `files` directly
            // below — so there's no one-frame lag when files changes.
            setResult(files);
            return;
        }

        const callId = ++latestCallIdRef.current;
        const handle = setTimeout(async () => {
            try {
                const filtered = await invoke<T[]>("filter_file_entries", {
                    files,
                    filters: {
                        searchTerm: criteria.searchTerm ?? null,
                        fileTypes: criteria.fileTypes ?? null,
                        dateFilter: criteria.dateFilter ?? null,
                        fileSizes: criteria.fileSizes ?? null,
                        folderTab: criteria.folderTab ?? null,
                    },
                });
                if (callId === latestCallIdRef.current) {
                    setResult(filtered);
                }
            } catch (err) {
                console.error("filter_file_entries failed:", err);
                if (callId === latestCallIdRef.current) {
                    setResult(files);
                }
            }
        }, debounceMs);

        return () => clearTimeout(handle);
    }, [
        files,
        criteria.searchTerm,
        criteria.fileTypes,
        criteria.dateFilter,
        criteria.fileSizes,
        criteria.folderTab,
        debounceMs,
        isNoopCriteria,
    ]);

    // When there are no filters at all, skip the result-state roundtrip and
    // return `files` directly. The effect-driven path lags by one render
    // (the effect's `setResult` only commits AFTER the current render
    // returns), which caused the nested-folder "No entries" flash —
    // `nestedListing.data` flipped from [] → [file1,file2] in render N,
    // but `useFilteredFiles` still returned the previous `[]` until
    // render N+1, so DriveContent briefly saw an empty list with
    // isLoading=false and rendered the empty-state UI.
    return isNoopCriteria ? files : result;
}
