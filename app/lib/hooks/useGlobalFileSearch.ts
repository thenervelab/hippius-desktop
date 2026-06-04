import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * Global (account-wide, cross-folder) file search for the sidebar palette.
 *
 * Wraps the `search_files` Rust command, which calls the HCFS server's
 * `/search_files` endpoint — the *same* cloud endpoint and auth the web
 * console's file search uses. This replaces `useGlobalRecursiveFileSearch`,
 * which fanned the local `search_user_files_recursive` IPC across drives and
 * therefore only ever found files already synced to *this* device. Going
 * through the server means uploads from other devices — and files under drives
 * not configured here — now appear in the results, fixing the "sidebar search
 * doesn't find my files" report.
 *
 * The return shape (`{ data, isFetching }`) matches the hook it replaces so the
 * palette consumes it unchanged. Results map to `FormattedUserFile`, the same
 * shape the "last uploads" list uses, so both render through one row.
 */
export const GLOBAL_FILE_SEARCH_QUERY_KEY = "global-file-search";

/** Default result cap; the server clamps and the palette scrolls. */
const DEFAULT_LIMIT = 50;
/** Debounce window before issuing the search (console uses 500; 250 feels
 *  snappier for an in-app palette while still coalescing fast typing). */
const DEFAULT_DEBOUNCE_MS = 250;

export interface UseGlobalFileSearchOptions {
  /** Owner account (ss58) used to scope the server query. */
  accountId: string | null | undefined;
  /** Live search term from the input (this hook debounces it internally). */
  searchTerm: string;
  /** When false, the hook never fires and returns an empty list. */
  enabled?: boolean;
  /** Max results to request. Defaults to {@link DEFAULT_LIMIT}. */
  limit?: number;
  /** Debounce window in ms. Defaults to {@link DEFAULT_DEBOUNCE_MS}. */
  debounceMs?: number;
}

export interface UseGlobalFileSearchResult {
  data: FormattedUserFile[];
  /** True from the moment the term changes until the matching query settles
   *  (includes the debounce window) so the palette shows its skeleton instead
   *  of briefly flashing "no results". */
  isFetching: boolean;
}

export function useGlobalFileSearch(
  options: UseGlobalFileSearchOptions,
): UseGlobalFileSearchResult {
  const {
    accountId,
    searchTerm,
    enabled = true,
    limit = DEFAULT_LIMIT,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = options;

  const [debouncedTerm, setDebouncedTerm] = useState(searchTerm);
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedTerm(searchTerm), debounceMs);
    return () => clearTimeout(handle);
  }, [searchTerm, debounceMs]);

  const trimmed = debouncedTerm.trim();
  const queryEnabled = enabled && !!accountId && trimmed.length > 0;

  const { data, isFetching } = useQuery({
    // The trimmed term is part of the key so each distinct query caches
    // separately and a refetch never returns a previous term's results.
    queryKey: [GLOBAL_FILE_SEARCH_QUERY_KEY, accountId, trimmed, limit],
    queryFn: async (): Promise<FormattedUserFile[]> => {
      if (!accountId) return [];
      return invoke<FormattedUserFile[]>("search_files", {
        accountId,
        params: { query: trimmed, limit },
      });
    },
    enabled: queryEnabled,
    // Track the input closely: results must reflect the current query, not a
    // stale cached one, and they're cheap to re-fetch.
    staleTime: 0,
    gcTime: 0,
    retry: 1,
    retryDelay: 1000,
  });

  // The query hasn't fired yet while the live term is ahead of the debounced
  // one. Gate on the *live* term + `enabled` so clearing the box drops the
  // loading state immediately rather than after the debounce.
  const isDebouncing =
    enabled && !!accountId && searchTerm.trim().length > 0 && searchTerm !== debouncedTerm;

  return {
    data: queryEnabled ? (data ?? []) : [],
    isFetching: isFetching || isDebouncing,
  };
}

export default useGlobalFileSearch;
