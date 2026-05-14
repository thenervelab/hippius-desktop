import { useEffect, useMemo, useRef, useState } from "react";
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
        (!criteria.fileTypes || criteria.fileTypes.length === 0) &&
        !criteria.dateFilter &&
        (!criteria.fileSizes || criteria.fileSizes.length === 0) &&
        !criteria.folderTab;

    // Identity of the inputs that should produce the current `data`. When
    // any field (or the `files` reference) changes, this object changes
    // and `loadedInputsRef` no longer matches — that mismatch is what
    // surfaces `isFiltering: true` to the caller so it can show a
    // skeleton instead of stale rows.
    const currentInputs = useMemo(
        () => ({
            files,
            searchTerm: criteria.searchTerm,
            fileTypes: criteria.fileTypes,
            dateFilter: criteria.dateFilter,
            fileSizes: criteria.fileSizes,
            folderTab: criteria.folderTab,
        }),
        [
            files,
            criteria.searchTerm,
            criteria.fileTypes,
            criteria.dateFilter,
            criteria.fileSizes,
            criteria.folderTab,
        ],
    );
    const loadedInputsRef = useRef<typeof currentInputs | null>(null);
    // Bumped after every settled fetch so the render-time `isFiltering`
    // derivation re-evaluates against the updated `loadedInputsRef`. A
    // bare ref mutation wouldn't trigger a re-render on its own.
    const [, forceRender] = useState(0);

    useEffect(() => {
        if (isNoopCriteria) {
            // Keep `result` in sync with `files` for the next render, but
            // the return value already short-circuits to `files` directly
            // below — so there's no one-frame lag when files changes.
            setResult(files);
            loadedInputsRef.current = currentInputs;
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
                        fileTypes: criteria.fileTypes ?? null,
                        dateFilter: criteria.dateFilter ?? null,
                        fileSizes: criteria.fileSizes ?? null,
                        folderTab: criteria.folderTab ?? null,
                    },
                });
                if (callId === latestCallIdRef.current) {
                    setResult(filtered);
                    loadedInputsRef.current = currentInputs;
                    forceRender((tick) => tick + 1);
                }
            } catch (err) {
                console.error("filter_file_entries failed:", err);
                if (callId === latestCallIdRef.current) {
                    setResult(files);
                    loadedInputsRef.current = currentInputs;
                    forceRender((tick) => tick + 1);
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
        currentInputs,
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
    const isFiltering = loadedInputsRef.current !== currentInputs;
    return { data: result, isFiltering };
}
