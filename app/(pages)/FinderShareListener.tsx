"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { finderShareLinkAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { FinderShareCreated } from "@/app/lib/tauri/shares";
import { registerTauriListeners } from "@/lib/utils/tauriListeners";

/**
 * Invisible component that surfaces a share minted from the macOS Finder
 * right-click menu.
 *
 * The share is created entirely in Rust (`finder_bridge::dispatch`) before
 * the FE is involved, so this listener does no minting — it just seeds
 * `finderShareLinkAtom`, which opens `ShareFileModal` straight into its
 * `done` state (URL + copy/open/revoke). The modal owns the clipboard copy
 * and toast, so the copy logic stays in one place and a Finder share and an
 * in-app share present identically.
 *
 * The `finder:share-created` event only ever fires on macOS once a share has
 * actually been minted, so this listener is safe to mount unconditionally on
 * every platform — elsewhere it simply never receives an event.
 */
export default function FinderShareListener() {
  const setFinderShareLink = useSetAtom(finderShareLinkAtom);

  useEffect(() => {
    const { cleanup } = registerTauriListeners([
      [
        "finder:share-created",
        (event) => setFinderShareLink(event.payload as FinderShareCreated),
      ],
    ]);
    return cleanup;
  }, [setFinderShareLink]);

  return null;
}
