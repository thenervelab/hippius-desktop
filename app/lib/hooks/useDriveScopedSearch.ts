"use client";

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { FileFilterRequest } from "@/app/lib/hooks/useFilteredFiles";

export const DRIVE_SCOPED_SEARCH_QUERY_KEY = "drive-scoped-search";

export interface UseDriveScopedSearchOptions {
  accountId: string | null | undefined;
  /** Drive label to scope the search to. */
  label: string | null | undefined;
  criteria: FileFilterRequest;
  debounceMs?: number;
  enabled?: boolean;
}

export interface UseDriveScopedSearchResult {
  data: FormattedUserFile[];
  isFetching: boolean;
}

/**
 * Search one drive on the SERVER, for a drive this device does not sync.
 *
 * The recursive search walks local disk, which a browsed drive has none
 * of — so searching one could previously only filter the rows already on
 * screen, and anything inside a subfolder was invisible. That made search
 * look broken next to a local drive, where it spans the whole tree.
 *
 * Scoping is Rust's job (`search_files_in_drive` resolves the drive's
 * identity): the server wants a folder hash, and deriving one from a
 * label here is correct only for an own drive and names the wrong
 * namespace for a member drive.
 */
export function useDriveScopedSearch(
  options: UseDriveScopedSearchOptions,
): UseDriveScopedSearchResult {
  const { accountId, label, criteria, debounceMs = 200, enabled = true } = options;

  const term = criteria.searchTerm?.trim() ?? "";
  const [debouncedTerm, setDebouncedTerm] = useState(term);
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedTerm(term), debounceMs);
    return () => clearTimeout(handle);
  }, [term, debounceMs]);

  const extension = criteria.fileExtensions?.[0];
  const shouldFire = enabled && Boolean(accountId) && Boolean(label) &&
    (debouncedTerm.length > 0 || Boolean(extension));

  const { data, isFetching } = useQuery({
    queryKey: [DRIVE_SCOPED_SEARCH_QUERY_KEY, accountId, label, debouncedTerm, extension],
    queryFn: async (): Promise<FormattedUserFile[]> =>
      invoke<FormattedUserFile[]>("search_files_in_drive", {
        accountId,
        label,
        params: {
          query: debouncedTerm || undefined,
          fileExtension: extension,
        },
      }),
    enabled: shouldFire,
    // Results must reflect the current query, never a cached earlier one.
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  });

  return {
    data: shouldFire ? (data ?? []) : [],
    // The query has not fired while the live term is ahead of the
    // debounced one; report that as fetching so the list does not flash
    // "no results" between keystrokes.
    isFetching: shouldFire && (isFetching || term !== debouncedTerm),
  };
}
