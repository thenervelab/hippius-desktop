"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { finderShareAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type {
  FinderShareCreated,
  FinderShareFailed,
  FinderShareStarted,
} from "@/app/lib/tauri/shares";
import { registerTauriListeners } from "@/lib/utils/tauriListeners";

/**
 * Invisible component that surfaces a share minted from the macOS Finder
 * right-click menu.
 *
 * The share is minted entirely in Rust (`finder_bridge::dispatch`), which
 * brackets the (possibly slow) mint with three events; this listener does no
 * minting, it just drives `finderShareAtom` through them so `ShareFileModal`
 * shows a spinner immediately, then the ready link — or an error. The modal
 * owns the clipboard copy and toast, so a Finder share and an in-app share
 * present identically.
 *
 * These events only ever fire on macOS once a click has actually been
 * dispatched, so the listener is safe to mount unconditionally on every
 * platform — elsewhere it simply never receives one.
 */
export default function FinderShareListener() {
  const setFinderShare = useSetAtom(finderShareAtom);

  useEffect(() => {
    const { cleanup } = registerTauriListeners([
      [
        "finder:share-started",
        (event) => {
          const { name, private: isPrivate } =
            event.payload as FinderShareStarted;
          setFinderShare({ kind: "pending", name, private: isPrivate });
        },
      ],
      [
        "finder:share-created",
        (event) =>
          setFinderShare({
            kind: "done",
            share: event.payload as FinderShareCreated,
          }),
      ],
      [
        "finder:share-failed",
        (event) => {
          const { name, message } = event.payload as FinderShareFailed;
          setFinderShare({ kind: "failed", name, message });
        },
      ],
    ]);
    return cleanup;
  }, [setFinderShare]);

  return null;
}
