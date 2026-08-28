// Read-only "which folders are currently shared via a live link" index —
// the folder-share sibling of `useSharedFiles`, backing the per-folder
// "Shared" badge.
//
// Where the file index matches by `(label, relativePath)` from the local
// `share_origin` sidecar, this one matches by the share's server-side
// identity: the owner listing carries `(folderHash, pathPrefix)` and the
// badge derives the same pair from the row — `driveFolderHash(label)` plus
// the SAME `folderShareRelativePath` resolution the mint uses — so a share
// minted for a folder is found under exactly the key it was created with.
// Folder shares deliberately record no `share_origin` row (the file-share
// prune would evict it), so this listing is the only badge source.
//
// The owner listing includes revoked and expired rows (they linger until the
// server-side reaper sweeps them); a dead link must not badge a folder as
// shared, so revoked rows are dropped at index build and expired ones at
// lookup time (expiry is clock-dependent, the index is cached).
//
// Shares the TanStack Query cache key with the `/shares` page, so every
// badge instance in a long listing collapses onto ONE request/poll.

"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";

import { listFolderShares, type FolderShareSummary } from "@/app/lib/tauri/shares";
import { folderShareFeatureEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { driveFolderHash } from "@/app/lib/utils/folderShareGating";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { LIVE_DATA_REFRESH_MS } from "@/lib/constants";

export const FOLDER_SHARES_QUERY_KEY = "folder-shares-list";

type FolderShareIndex = Map<string, FolderShareSummary[]>;

const EMPTY_INDEX: FolderShareIndex = new Map();
const EMPTY_ROWS: FolderShareSummary[] = [];

/** `folderHash` is hex and `pathPrefix` a validated rel-path — neither can
 *  contain `\n`, so the pair joins into a collision-free key. */
function indexKey(folderHash: string, pathPrefix: string): string {
  return `${folderHash}\n${pathPrefix}`;
}

/** Listing rows → lookup index. Revoked rows are dropped here — a revoked
 *  link is dead forever, unlike expiry there is no clock to re-check. */
export function buildFolderShareIndex(rows: FolderShareSummary[]): FolderShareIndex {
  const index: FolderShareIndex = new Map();
  for (const row of rows) {
    if (row.revokedAt !== null) continue;
    const key = indexKey(row.folderHash, row.pathPrefix);
    const list = index.get(key);
    if (list) list.push(row);
    else index.set(key, [row]);
  }
  return index;
}

/**
 * Live share rows for exactly `(folderHash, pathPrefix)` — a whole-drive
 * share (`""`) does not badge its subfolders, matching what was actually
 * shared. Expired rows are filtered here rather than at build so a cached
 * index cannot keep badging a link past its expiry. Pure and exported so
 * the matching is testable.
 */
export function selectFolderSharesFor(
  index: FolderShareIndex,
  folderHash: string | undefined,
  pathPrefix: string,
  now: number = Date.now(),
): FolderShareSummary[] {
  if (!folderHash) return EMPTY_ROWS;
  const rows = index.get(indexKey(folderHash, pathPrefix));
  if (!rows) return EMPTY_ROWS;
  const live = rows.filter((row) => {
    if (row.expiresAt === null) return true;
    const expiresMs = Date.parse(row.expiresAt);
    return Number.isNaN(expiresMs) || expiresMs > now;
  });
  return live.length > 0 ? live : EMPTY_ROWS;
}

/**
 * Live folder-share rows for one folder row, or `[]` when it isn't shared.
 *
 * `enabled: false` (a file row) skips the hash computation; the listing query
 * itself is additionally gated on the `folder_shares` capability, so old
 * servers see no traffic and no badges.
 */
export function useFolderShareBadge(
  label: string | null | undefined,
  relativePath: string | null | undefined,
  enabled: boolean,
): FolderShareSummary[] {
  const { polkadotAddress } = useWalletAuth();
  const folderSharesEnabled = useAtomValue(folderShareFeatureEnabledAtom);

  // `driveFolderHash` is async (WebCrypto); the badge renders nothing until
  // the memoized hash resolves, which is one microtask after first mount.
  const [folderHash, setFolderHash] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !label) {
      setFolderHash(undefined);
      return;
    }
    let cancelled = false;
    void driveFolderHash(label).then((hash) => {
      if (!cancelled) setFolderHash(hash);
    });
    return () => {
      cancelled = true;
    };
  }, [label, enabled]);

  const { data } = useQuery({
    queryKey: [FOLDER_SHARES_QUERY_KEY, polkadotAddress],
    queryFn: () => listFolderShares(),
    enabled: Boolean(polkadotAddress) && folderSharesEnabled && enabled,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: LIVE_DATA_REFRESH_MS,
    select: buildFolderShareIndex,
  });

  if (!enabled) return EMPTY_ROWS;
  return selectFolderSharesFor(data ?? EMPTY_INDEX, folderHash, relativePath ?? "");
}
