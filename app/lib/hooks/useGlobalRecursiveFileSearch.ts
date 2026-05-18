import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { FileFilterRequest } from "@/app/lib/hooks/useFilteredFiles";

/**
 * Global (cross-drive) file search. Fans out the existing
 * `search_user_files_recursive` IPC across every configured drive label
 * in parallel and merges the results into a single flat list of files.
 *
 * Used by the sidebar search, which lives outside any drive context and
 * needs to find files anywhere in the user's account. Folder rows are
 * filtered out — leaf files only — and duplicates (same `(label, path)`)
 * are deduped to guard against any IPC quirk.
 */
export interface UseGlobalRecursiveFileSearchOptions {
    accountId: string | null | undefined;
    /** Drive labels to search. Pass an empty array to disable. */
    labels: string[];
    /** Filter criteria mirroring `FileFilterRequest`. */
    criteria: FileFilterRequest;
    /** Debounce window for the IPC fan-out. Defaults to 200 ms. */
    debounceMs?: number;
    /** When false, the hook never fires and returns an empty list. */
    enabled?: boolean;
}

export interface UseGlobalRecursiveFileSearchResult {
    data: FormattedUserFile[];
    /** True between input change and IPC settlement for the latest inputs. */
    isFetching: boolean;
}

function hasAnyCriteria(criteria: FileFilterRequest): boolean {
    return Boolean(
        criteria.searchTerm?.trim() ||
            (criteria.fileExtensions && criteria.fileExtensions.length > 0) ||
            (criteria.dateRange && criteria.dateRange.from) ||
            (criteria.fileSizes && criteria.fileSizes.length > 0),
    );
}

export function useGlobalRecursiveFileSearch(
    options: UseGlobalRecursiveFileSearchOptions,
): UseGlobalRecursiveFileSearchResult {
    const {
        accountId,
        labels,
        criteria,
        debounceMs = 200,
        enabled = true,
    } = options;

    const [result, setResult] = useState<FormattedUserFile[]>([]);
    const [isFetching, setIsFetching] = useState(false);
    const latestCallIdRef = useRef(0);

    // Stable serialisation of the criteria/labels so the effect only
    // re-fires on meaningful input changes (avoids new-array identity
    // churn from upstream re-renders).
    const criteriaKey = useMemo(
        () =>
            JSON.stringify({
                s: criteria.searchTerm ?? null,
                e: criteria.fileExtensions ?? null,
                d: criteria.dateRange ?? null,
                z: criteria.fileSizes ?? null,
            }),
        [
            criteria.searchTerm,
            criteria.fileExtensions,
            criteria.dateRange,
            criteria.fileSizes,
        ],
    );
    const labelsKey = useMemo(
        () => labels.slice().sort().join("|"),
        [labels],
    );

    const shouldFire =
        enabled &&
        Boolean(accountId) &&
        labels.length > 0 &&
        hasAnyCriteria(criteria);

    useEffect(() => {
        if (!shouldFire) {
            setResult([]);
            setIsFetching(false);
            return;
        }

        const callId = ++latestCallIdRef.current;
        setIsFetching(true);

        const handle = setTimeout(async () => {
            try {
                const allResults = await Promise.all(
                    labels.map((label) =>
                        invoke<FormattedUserFile[]>(
                            "search_user_files_recursive",
                            {
                                accountId,
                                label,
                                subfolder: null,
                                filters: {
                                    searchTerm: criteria.searchTerm ?? null,
                                    fileExtensions:
                                        criteria.fileExtensions ?? null,
                                    dateRange: criteria.dateRange ?? null,
                                    fileSizes: criteria.fileSizes ?? null,
                                    folderTab: null,
                                },
                            },
                        ).catch((err) => {
                            console.error(
                                `search_user_files_recursive(${label}) failed:`,
                                err,
                            );
                            return [] as FormattedUserFile[];
                        }),
                    ),
                );

                if (callId !== latestCallIdRef.current) return;

                const seen = new Set<string>();
                const merged: FormattedUserFile[] = [];
                for (const list of allResults) {
                    for (const file of list) {
                        if (file.isFolder) continue;
                        const key = `${file.label ?? ""}::${
                            file.actualFileName ?? file.name
                        }`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        merged.push(file);
                    }
                }
                setResult(merged);
                setIsFetching(false);
            } catch (err) {
                if (callId !== latestCallIdRef.current) return;
                console.error("Global recursive search failed:", err);
                setResult([]);
                setIsFetching(false);
            }
        }, debounceMs);

        return () => clearTimeout(handle);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shouldFire, accountId, labelsKey, criteriaKey, debounceMs]);

    return { data: result, isFetching };
}

export default useGlobalRecursiveFileSearch;
