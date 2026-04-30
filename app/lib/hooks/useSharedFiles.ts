// Read-only index of "which files are currently shared via a public
// link" for the current account. Backs the per-row "Shared" badge in
// the file list and any future "Shared" filter chip.
//
// Shares the TanStack Query cache key with the `/shares` page
// (`["shares-list", polkadotAddress]`), so the two surfaces deduplicate
// network traffic — opening the file list and `/shares` in the same
// session triggers exactly one `hcfs_list_shares` round-trip.
//
// The `select` projects the array into a `Map<label, Set<relativePath>>`
// so per-row lookups are O(1) instead of O(N). Equality on the
// projected Map is identity-based; TanStack only fires a re-render
// when `data` actually changes, which means a poll that returns the
// same set won't re-render every file row.
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

type SharedIndex = Map<string, Set<string>>;

interface UseSharedFilesResult {
  /** True when this `(label, relativePath)` pair is currently shared. */
  isShared: (label: string | null | undefined, relativePath: string | null | undefined) => boolean;
  /** True while the first fetch is in flight. */
  isLoading: boolean;
}

const EMPTY_INDEX: SharedIndex = new Map();

function buildIndex(rows: ShareSummary[]): SharedIndex {
  const index: SharedIndex = new Map();
  for (const row of rows) {
    if (!row.folderLabel || !row.relativePath) continue;
    let bucket = index.get(row.folderLabel);
    if (!bucket) {
      bucket = new Set();
      index.set(row.folderLabel, bucket);
    }
    bucket.add(row.relativePath);
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

  // Stable identity per `index` so callers that pass the helper into
  // a memo dependency don't churn unnecessarily.
  const isShared = useMemo(
    () =>
      (label: string | null | undefined, relativePath: string | null | undefined): boolean => {
        if (!label || !relativePath) return false;
        const bucket = index.get(label);
        return bucket ? bucket.has(relativePath) : false;
      },
    [index]
  );

  return { isShared, isLoading: isLoading && shareEnabled };
}
