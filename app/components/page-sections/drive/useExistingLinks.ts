"use client";

// The one hook every menu and the Share via link dialog ask "does this file or
// folder already have a live link, and what can I copy?" (`existingLink.ts`).
// It reads the same cached listings as the row's link icon and its Insights
// (`useSharedFiles`, the folder-share listing), so nothing here asks the
// server per row.

import { useCallback, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";

import { folderShareFeatureEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  buildFolderShareIndex,
  FOLDER_SHARES_QUERY_KEY,
  selectFolderSharesFor,
} from "@/app/lib/hooks/useFolderShares";
import { useSharedFiles } from "@/app/lib/hooks/useSharedFiles";
import { listFolderShares } from "@/app/lib/tauri/shares";
import { captureSharesFrom } from "@/app/lib/utils/fileLinks";
import { driveFolderHash } from "@/app/lib/utils/folderShareGating";
import { normalizeRelPath } from "@/app/lib/utils/relPath";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { LIVE_DATA_REFRESH_MS } from "@/lib/constants";
import { existingFileLink, existingFolderLink, type ExistingLink } from "./existingLink";

export interface ExistingLinks {
  /**
   * The item's live link and what can be copied from here, or `null` when it
   * has none (or its listing is not known yet: see `isLoadingFor`).
   * `relativePath` is the drive-relative path its links are found under
   * (`linkPathFor`, or a share target's `relativePath`).
   */
  linkFor: (file: FormattedUserFile, relativePath: string) => ExistingLink | null;
  /** The listing the answer comes from has not been read yet. */
  isLoadingFor: (file: FormattedUserFile) => boolean;
}

export function useExistingLinks(): ExistingLinks {
  const locked = useAtomValue(syncRequiresReauthAtom);
  const { getSharesFor, getUnplacedSharesNamed, isLoading: filesLoading } = useSharedFiles();

  // Folder links come from the folder-share listing, keyed by the drive's
  // folder hash (async: WebCrypto). Both are asked for only once a folder is
  // looked up, so a page of files never reads the folder listing.
  const { polkadotAddress } = useWalletAuth();
  const folderSharesEnabled = useAtomValue(folderShareFeatureEnabledAtom);
  const [wantFolders, setWantFolders] = useState(false);
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const pendingHashes = useRef(new Set<string>());
  const { data: folderIndex, isLoading: foldersLoading } = useQuery({
    queryKey: [FOLDER_SHARES_QUERY_KEY, polkadotAddress],
    queryFn: () => listFolderShares(),
    enabled: Boolean(polkadotAddress) && folderSharesEnabled && wantFolders,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: LIVE_DATA_REFRESH_MS,
    select: buildFolderShareIndex,
  });

  // A lookup runs during render, so it only schedules what it needs: the
  // folder listing and the drive's hash, each asked for once.
  const askForFolder = useCallback((label: string) => {
    queueMicrotask(() => {
      setWantFolders(true);
      if (pendingHashes.current.has(label)) return;
      pendingHashes.current.add(label);
      void driveFolderHash(label).then((hash) => setHashes((prev) => ({ ...prev, [label]: hash })));
    });
  }, []);

  const linkFor = useCallback(
    (file: FormattedUserFile, relativePath: string): ExistingLink | null => {
      if (!file.label) return null;
      if (file.isFolder) {
        if (!folderSharesEnabled) return null;
        const hash = hashes[file.label];
        if (!hash || !wantFolders) {
          askForFolder(file.label);
          return null;
        }
        if (!folderIndex) return null;
        return existingFolderLink(selectFolderSharesFor(folderIndex, hash, relativePath), locked);
      }
      // A live upload row's path can carry a leading slash; the tray's rows
      // drop it the same way before they look their links up.
      const path = normalizeRelPath(relativePath);
      const rows = captureSharesFrom({ getSharesFor, getUnplacedSharesNamed }, file.label, path, file.size);
      return existingFileLink(rows, locked);
    },
    [askForFolder, folderIndex, folderSharesEnabled, getSharesFor, getUnplacedSharesNamed, hashes, locked, wantFolders],
  );

  const isLoadingFor = useCallback(
    (file: FormattedUserFile): boolean => {
      if (!file.isFolder) return filesLoading;
      if (!folderSharesEnabled || !file.label) return false;
      return !wantFolders || !hashes[file.label] || foldersLoading;
    },
    [filesLoading, folderSharesEnabled, foldersLoading, hashes, wantFolders],
  );

  return { linkFor, isLoadingFor };
}
