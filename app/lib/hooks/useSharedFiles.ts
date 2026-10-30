// Read-only index of "which files are currently shared via a public
// link" for the current account. Backs the per-row "Shared" badge in
// the file list and any future "Shared" filter chip.
//
// Shares the TanStack Query cache key with the `/shares` page
// (`["shares-list", polkadotAddress]`), so the two surfaces deduplicate
// network traffic — opening the file list and `/shares` in the same
// session triggers exactly one `hcfs_list_shares` round-trip.
//
// The `select` projects the array into a `Map<label, Map<relPath,
// ShareSummary[]>>`. The leaf is an array because a single file can
// have multiple active shares (one per Reshare), and the badge tooltip
// needs every row to compute "soonest expires in 3h" across all of
// them. Per-row lookup stays O(1). Equality on the projected Map is
// identity-based; TanStack only fires a re-render when `data` actually
// changes.
//
// Gated by `shareFeatureEnabledAtom`: if the server doesn't advertise
// shares, the query stays disabled and the hook returns an empty index
// — no network traffic, no badges.

"use client";

import { useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";

import { listShares, type ShareSummary } from "@/app/lib/tauri/shares";
import { buildShareIndex, EMPTY_SHARE_INDEX, shareLookups } from "@/app/lib/utils/fileLinks";
import { shareFeatureEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { LIVE_DATA_REFRESH_MS } from "@/lib/constants";

/** The share listing's query key, shared with the `/shares` page. */
export const SHARES_QUERY_KEY = "shares-list";

interface UseSharedFilesResult {
  /** Active share rows for this `(label, relativePath)` pair. Empty array for unshared files. */
  getSharesFor: (label: string | null | undefined, relativePath: string | null | undefined) => ShareSummary[];
  /**
   * Active links made from a file of this name that this device has no
   * origin for: made in the browser extension, the web console or on
   * another computer (`share_origin` is per device). The server names a
   * link's file by name and size only, so this is all there is to match
   * them by; callers decide where a name is specific enough to trust.
   */
  getUnplacedSharesNamed: (fileName: string | null | undefined) => ShareSummary[];
  /** True while the first fetch is in flight. */
  isLoading: boolean;
  /**
   * The listing could not be read and nothing is known: every file then
   * looks link-less, which must not be read as "has no link".
   */
  isError: boolean;
  /** Read the listing again. */
  refetch: () => void;
}

export function useSharedFiles(): UseSharedFilesResult {
  const { polkadotAddress } = useWalletAuth();
  const shareEnabled = useAtomValue(shareFeatureEnabledAtom);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [SHARES_QUERY_KEY, polkadotAddress],
    queryFn: () => listShares(),
    enabled: Boolean(polkadotAddress) && shareEnabled,
    // Shares the cache key with the /shares page. Both read the one
    // LIVE_DATA_REFRESH_MS constant, so they can no longer drift onto
    // two parallel polls the way two hand-kept copies could.
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: LIVE_DATA_REFRESH_MS,
    select: buildShareIndex,
  });

  const index = data ?? EMPTY_SHARE_INDEX;

  // Stable identity per `index` so callers that pass `getSharesFor`
  // into a memo dependency don't churn unnecessarily.
  const { getSharesFor, getUnplacedSharesNamed } = useMemo(() => shareLookups(index), [index]);

  return {
    getSharesFor,
    getUnplacedSharesNamed,
    isLoading: isLoading && shareEnabled,
    // Only while nothing is known: a failed refresh of a listing already
    // read keeps the rows it has.
    isError: isError && data === undefined,
    refetch: () => void refetch(),
  };
}

/**
 * One link from the share listing already in the cache, by its token, or
 * `null`. Reads only what is cached (any account's entry), so it never asks
 * the server: the Insights sheet's header uses it for the date the link was
 * made, and leaves the date out when the listing has not been loaded.
 */
export function findCachedShare(client: QueryClient, shareToken: string): ShareSummary | null {
  for (const [, data] of client.getQueriesData<unknown>({ queryKey: [SHARES_QUERY_KEY] })) {
    if (!Array.isArray(data)) continue;
    const row = (data as ShareSummary[]).find((r) => r?.shareToken === shareToken);
    if (row) return row;
  }
  return null;
}
