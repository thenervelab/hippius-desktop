import { useEffect, useRef, useState } from "react";
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
    enabled = true,
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

    // VALUE identity of the filter criteria that produced the current `data`.
    //
    // Serialized to a string ON PURPOSE: callers build `criteria` inline and
    // pass fresh array/object references for the SAME values every render (e.g.
    // an inline `fileExtensions` array). A reference-keyed identity therefore
    // changed every render, which — combined with the post-settle `forceRender`
    // below — re-ran the effect every render and blew past React's update depth
    // (the "Maximum update depth exceeded" loop). A string compares by value, so
    // equal criteria no longer re-trigger the effect regardless of references.
    //
    // Deliberately EXCLUDES `files`: a background refetch (sync completed) swaps
    // the `files` reference for the SAME view; keying `isFiltering` only on the
    // criteria keeps that refresh silent (no skeleton flash). The effect still
    // re-runs on `files` changes to re-filter the new data.
    const criteriaKey = JSON.stringify({
        searchTerm: criteria.searchTerm ?? null,
        fileExtensions: criteria.fileExtensions ?? null,
        dateRange: criteria.dateRange ?? null,
        fileSizes: criteria.fileSizes ?? null,
        folderTab: criteria.folderTab ?? null,
    });
    const loadedCriteriaKeyRef = useRef<string | null>(null);
    // Bumped after every settled fetch so the render-time `isFiltering`
    // derivation re-evaluates against the updated `loadedCriteriaRef`. A
    // bare ref mutation wouldn't trigger a re-render on its own.
    const [, forceRender] = useState(0);

    useEffect(() => {
        if (!enabled) {
            return;
        }
        if (isNoopCriteria) {
            // No filters: the hook's return short-circuits to `files` directly
            // (below), so there is nothing to compute here AND — critically —
            // nothing to setState. The old code called `setResult`/`forceRender`
            // here, which re-rendered the host every time the effect ran; when a
            // caller passed an unstable criterion reference the effect ran every
            // render, so that `forceRender` looped forever. Just bail.
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
                    loadedCriteriaKeyRef.current = criteriaKey;
                    forceRender((tick) => tick + 1);
                }
            } catch (err) {
                console.error("filter_file_entries failed:", err);
                if (callId === latestCallIdRef.current) {
                    setResult(files);
                    loadedCriteriaKeyRef.current = criteriaKey;
                    forceRender((tick) => tick + 1);
                }
            }
        }, debounceMs);

        return () => clearTimeout(handle);
        // `criteriaKey` captures every criterion by value, so the individual
        // `criteria.*` reads inside the IPC payload (which run with this render's
        // `criteria`) need not be listed — and listing the array/object fields
        // directly is exactly what reintroduces the unstable-reference loop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [files, criteriaKey, debounceMs, isNoopCriteria, enabled]);

    // When there are no filters at all, skip the result-state roundtrip and
    // return `files` directly. The effect-driven path lags by one render
    // (the effect's `setResult` only commits AFTER the current render
    // returns), which caused the nested-folder "No entries" flash —
    // `nestedListing.data` flipped from [] → [file1,file2] in render N,
    // but `useFilteredFiles` still returned the previous `[]` until
    // render N+1, so DriveContent briefly saw an empty list with
    // isLoading=false and rendered the empty-state UI.
    if (!enabled || isNoopCriteria) {
        return { data: files, isFiltering: false };
    }
    const isFiltering = loadedCriteriaKeyRef.current !== criteriaKey;
    return { data: result, isFiltering };
}
