import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { FileExtension } from "@/app/lib/utils/fileTypeMapper";
import type { DateRange } from "@/app/lib/types/dateRange";

/**
 * Shape of the filter criteria passed to the Rust `filter_file_entries`
 * IPC. Mirrors `FileFilterCriteria` in `src-tauri/src/sync/files.rs`
 * (all fields optional, camelCase via serde rename_all).
 *
 * `fileExtensions` and `dateRange` line up with the new console-style
 * filter dropdowns. The legacy `fileTypes` (coarse categories) and
 * `dateFilter` (preset string) fields are still accepted by Rust for
 * backward-compat but the desktop UI no longer sets them.
 */
export interface FileFilterRequest {
    searchTerm?: string;
    fileExtensions?: FileExtension[];
    dateRange?: DateRange;
    fileSizes?: number[];
    folderTab?: string | null;
}

export interface UseFilteredFilesResult<T> {
    /** Latest filter output. Stale during a pending IPC — see `isFiltering`. */
    data: T[];
    /**
     * True while the inputs (files reference or any criteria field) don't
     * match the inputs that produced the current `data` — i.e. a fresh IPC
     * is still on its way. Callers use this to show a loading skeleton
     * during transitions like nested→root navigation or sync-folder
     * switches, instead of briefly rendering the previous result.
     */
    isFiltering: boolean;
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
): UseFilteredFilesResult<T> {
    const [result, setResult] = useState<T[]>(files);
    // Track the latest invocation so an out-of-order late response can't
    // overwrite a newer one (user types quickly, older IPC resolves after).
    const latestCallIdRef = useRef(0);

    const isNoopCriteria =
        !criteria.searchTerm &&
        (!criteria.fileExtensions || criteria.fileExtensions.length === 0) &&
        !criteria.dateRange &&
        (!criteria.fileSizes || criteria.fileSizes.length === 0) &&
        !criteria.folderTab;

    // Identity of the FILTER CRITERIA that produced the current `data`.
    // Deliberately EXCLUDES `files`: a background refetch (sync completed) swaps
    // the `files` reference for the SAME view, and surfacing `isFiltering: true`
    // for that flashed the loading skeleton on every silent refresh (the
    // flicker bug). The effect below still re-runs on `files` changes (so the
    // new data gets re-filtered) and resets this ref to the unchanged criteria,
    // so the refresh applies silently. `isFiltering` is therefore true only when
    // the USER changed a criterion (search / filter / folder tab) and the new
    // IPC result hasn't landed yet.
    const currentCriteria = useMemo(
        () => ({
            searchTerm: criteria.searchTerm,
            fileExtensions: criteria.fileExtensions,
            dateRange: criteria.dateRange,
            fileSizes: criteria.fileSizes,
            folderTab: criteria.folderTab,
        }),
        [
            criteria.searchTerm,
            criteria.fileExtensions,
            criteria.dateRange,
            criteria.fileSizes,
            criteria.folderTab,
        ],
    );
    const loadedCriteriaRef = useRef<typeof currentCriteria | null>(null);
    // Bumped after every settled fetch so the render-time `isFiltering`
    // derivation re-evaluates against the updated `loadedCriteriaRef`. A
    // bare ref mutation wouldn't trigger a re-render on its own.
    const [, forceRender] = useState(0);

    useEffect(() => {
        if (isNoopCriteria) {
            // Keep `result` in sync with `files` for the next render, but
            // the return value already short-circuits to `files` directly
            // below — so there's no one-frame lag when files changes.
            setResult(files);
            loadedCriteriaRef.current = currentCriteria;
            forceRender((tick) => tick + 1);
            return;
        }

        const callId = ++latestCallIdRef.current;
        const handle = setTimeout(async () => {
            try {
                const filtered = await invoke<T[]>("filter_file_entries", {
                    files,
                    filters: {
                        searchTerm: criteria.searchTerm ?? null,
                        fileExtensions: criteria.fileExtensions ?? null,
                        dateRange: criteria.dateRange ?? null,
                        fileSizes: criteria.fileSizes ?? null,
                        folderTab: criteria.folderTab ?? null,
                    },
                });
                if (callId === latestCallIdRef.current) {
                    setResult(filtered);
                    loadedCriteriaRef.current = currentCriteria;
                    forceRender((tick) => tick + 1);
                }
            } catch (err) {
                console.error("filter_file_entries failed:", err);
                if (callId === latestCallIdRef.current) {
                    setResult(files);
                    loadedCriteriaRef.current = currentCriteria;
                    forceRender((tick) => tick + 1);
                }
            }
        }, debounceMs);

        return () => clearTimeout(handle);
    }, [
        files,
        criteria.searchTerm,
        criteria.fileExtensions,
        criteria.dateRange,
        criteria.fileSizes,
        criteria.folderTab,
        debounceMs,
        isNoopCriteria,
        currentCriteria,
    ]);

    // When there are no filters at all, skip the result-state roundtrip and
    // return `files` directly. The effect-driven path lags by one render
    // (the effect's `setResult` only commits AFTER the current render
    // returns), which caused the nested-folder "No entries" flash —
    // `nestedListing.data` flipped from [] → [file1,file2] in render N,
    // but `useFilteredFiles` still returned the previous `[]` until
    // render N+1, so DriveContent briefly saw an empty list with
    // isLoading=false and rendered the empty-state UI.
    if (isNoopCriteria) {
        return { data: files, isFiltering: false };
    }
    const isFiltering = loadedCriteriaRef.current !== currentCriteria;
    return { data: result, isFiltering };
}
