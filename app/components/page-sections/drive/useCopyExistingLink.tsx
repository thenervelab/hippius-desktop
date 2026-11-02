"use client";

// "Copy link" for a file or folder that already has a live link: copies that
// link, key included, and never makes one (Share via link is where links are
// made). Offered on every file menu by `useCopyLinkItem`, and by the file
// viewer and the Share via link dialog through `useCopyExistingLink`.

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "jotai";
import { Copy } from "lucide-react";
import { toast } from "sonner";

import type { ActionItem } from "@/app/components/ui/alt-table/TableActionMenu";
import { activeRecoveryCheckAtom } from "@/app/lib/global-atoms/recoveryAtoms";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  buildFolderShareIndex,
  FOLDER_SHARES_QUERY_KEY,
  selectFolderSharesFor,
} from "@/app/lib/hooks/useFolderShares";
import { SHARES_QUERY_KEY } from "@/app/lib/hooks/useSharedFiles";
import { useUnlockFlow } from "@/app/lib/hooks/useUnlockFlow";
import { listFolderShares, listShares } from "@/app/lib/tauri/shares";
import { buildShareIndex, captureSharesFrom, shareLookups } from "@/app/lib/utils/fileLinks";
import { driveFolderHash } from "@/app/lib/utils/folderShareGating";
import { normalizeRelPath } from "@/app/lib/utils/relPath";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import {
  COPY_FAILED,
  LINK_COPIED,
  LINK_NEEDS_PASSWORD,
} from "@/components/page-sections/shares/insights/panelLinkMedia";
import {
  copyLinkLabel,
  existingFileLink,
  existingFolderLink,
  LINK_ELSEWHERE_MESSAGE,
  type ExistingLink,
} from "./existingLink";
import { useExistingLinks } from "./useExistingLinks";

/** The item whose link is copied, and the drive-relative path its links are under. */
export interface LinkTarget {
  file: FormattedUserFile;
  relativePath: string;
}

/** Put the link on the clipboard and say so. */
export async function copyLinkToClipboard(url: string, needsPassword: boolean): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    toast.success(LINK_COPIED, needsPassword ? { description: LINK_NEEDS_PASSWORD } : undefined);
    return true;
  } catch {
    toast.error(COPY_FAILED);
    return false;
  }
}

// The unlock waiting to copy, if any. Module-wide on purpose: the menu that
// asked is usually gone by the time the unlock dialog closes, and a second
// press replaces the first rather than copying twice.
let stopWaiting: (() => void) | null = null;

/**
 * Copy an item's existing link: at once when it is here; after the app is
 * unlocked when Hippius is locked on this computer (the key of a link made
 * elsewhere comes back with the unlock); otherwise a plain sentence saying
 * where it can be copied. Nothing here can make a link.
 */
export function useCopyExistingLink() {
  const { unlock } = useUnlockFlow();
  const store = useStore();
  const queryClient = useQueryClient();
  const { polkadotAddress } = useWalletAuth();

  // After an unlock the listing is read afresh: Rust can now open the owner
  // wraps, so the link's key is in it. The cached listing is refreshed too,
  // so the menus and the dialog say "Copy link" from then on.
  const copyAfterUnlock = useCallback(
    async ({ file, relativePath }: LinkTarget) => {
      if (store.get(syncRequiresReauthAtom) || !file.label) return;
      let link: ExistingLink | null = null;
      try {
        if (file.isFolder) {
          const [rows, hash] = await Promise.all([
            queryClient.fetchQuery({
              queryKey: [FOLDER_SHARES_QUERY_KEY, polkadotAddress],
              queryFn: () => listFolderShares(),
              staleTime: 0,
            }),
            driveFolderHash(file.label),
          ]);
          link = existingFolderLink(selectFolderSharesFor(buildFolderShareIndex(rows), hash, relativePath), false);
        } else {
          const rows = await queryClient.fetchQuery({
            queryKey: [SHARES_QUERY_KEY, polkadotAddress],
            queryFn: () => listShares(),
            staleTime: 0,
          });
          const lookups = shareLookups(buildShareIndex(rows));
          link = existingFileLink(captureSharesFrom(lookups, file.label, normalizeRelPath(relativePath), file.size), false);
        }
      } catch {
        toast.error(COPY_FAILED);
        return;
      }
      if (link?.state === "ready" && link.url) await copyLinkToClipboard(link.url, link.needsPassword);
      else if (link) toast(LINK_ELSEWHERE_MESSAGE);
    },
    [polkadotAddress, queryClient, store],
  );

  return useCallback(
    (link: ExistingLink, target: LinkTarget) => {
      if (link.state === "ready" && link.url) {
        void copyLinkToClipboard(link.url, link.needsPassword);
        return;
      }
      if (link.state === "elsewhere") {
        toast(LINK_ELSEWHERE_MESSAGE);
        return;
      }
      stopWaiting?.();
      stopWaiting = null;
      void unlock().then(() => {
        // Nothing was locked after all: copy now.
        if (!store.get(syncRequiresReauthAtom)) {
          void copyAfterUnlock(target);
          return;
        }
        // The seed-phrase sign-in took over the window: nothing will close
        // to resume from, so the next press starts over.
        if (!store.get(activeRecoveryCheckAtom)) return;
        // Watched in the store, not through a render, so an open and close
        // between two renders is still seen. A cancelled unlock leaves the
        // app locked, and `copyAfterUnlock` then copies nothing.
        const stop = store.sub(activeRecoveryCheckAtom, () => {
          if (store.get(activeRecoveryCheckAtom)) return;
          stop();
          if (stopWaiting === stop) stopWaiting = null;
          void copyAfterUnlock(target);
        });
        stopWaiting = stop;
      });
    },
    [copyAfterUnlock, store, unlock],
  );
}

/**
 * The "Copy link" menu item for an item that already has a live link
 * ("Unlock to copy link" while its key waits on an unlock), or nothing for
 * one with no link: those have Share via link. Callers put it directly above
 * Share via link. `onSelect` runs first (a menu that closes itself).
 */
export function useCopyLinkItem() {
  const { linkFor } = useExistingLinks();
  const copy = useCopyExistingLink();
  return useCallback(
    (file: FormattedUserFile, relativePath: string, onSelect?: () => void): ActionItem[] => {
      const link = linkFor(file, relativePath);
      if (!link) return [];
      return [
        {
          icon: <Copy className="size-4" />,
          itemTitle: copyLinkLabel(link),
          onItemClick: (e?: React.MouseEvent) => {
            // Not `preventDefault`: Radix would then keep the menu open.
            e?.stopPropagation();
            onSelect?.();
            copy(link, { file, relativePath });
          },
        },
      ];
    },
    [copy, linkFor],
  );
}
