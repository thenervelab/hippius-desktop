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
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";

import { listShares, type ShareSummary } from "@/app/lib/tauri/shares";
import { shareFeatureEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

const SHARES_QUERY_KEY = "shares-list";
// Match the /shares page so the cache is genuinely shared. Bumping
// either side without the other risks two parallel polls.
const REFRESH_INTERVAL_MS = 30_000;

type SharedIndex = Map<string, Map<string, ShareSummary[]>>;

interface UseSharedFilesResult {
  /** Active share rows for this `(label, relativePath)` pair. Empty array for unshared files. */
  getSharesFor: (label: string | null | undefined, relativePath: string | null | undefined) => ShareSummary[];
  /** True while the first fetch is in flight. */
  isLoading: boolean;
}

const EMPTY_INDEX: SharedIndex = new Map();
const EMPTY_ROWS: ShareSummary[] = [];

function buildIndex(rows: ShareSummary[]): SharedIndex {
  const index: SharedIndex = new Map();
  for (const row of rows) {
    if (!row.folderLabel || !row.relativePath) continue;
    let folder = index.get(row.folderLabel);
    if (!folder) {
      folder = new Map();
      index.set(row.folderLabel, folder);
    }
    const list = folder.get(row.relativePath);
    if (list) {
      list.push(row);
    } else {
      folder.set(row.relativePath, [row]);
    }
  }
  return index;
}

export function useSharedFiles(): UseSharedFilesResult {
  const { polkadotAddress } = useWalletAuth();
  const shareEnabled = useAtomValue(shareFeatureEnabledAtom);

  const { data, isLoading } = useQuery({
    queryKey: [SHARES_QUERY_KEY, polkadotAddress],
    queryFn: () => listShares(),
    enabled: Boolean(polkadotAddress) && shareEnabled,
    refetchInterval: REFRESH_INTERVAL_MS,
    select: buildIndex,
  });

  const index = data ?? EMPTY_INDEX;

  // Stable identity per `index` so callers that pass `getSharesFor`
  // into a memo dependency don't churn unnecessarily.
  const getSharesFor = useMemo(() => {
    return (
      label: string | null | undefined,
      relativePath: string | null | undefined,
    ): ShareSummary[] => {
      if (!label || !relativePath) return EMPTY_ROWS;
      const folder = index.get(label);
      if (!folder) return EMPTY_ROWS;
      return folder.get(relativePath) ?? EMPTY_ROWS;
    };
  }, [index]);

  return { getSharesFor, isLoading: isLoading && shareEnabled };
}
