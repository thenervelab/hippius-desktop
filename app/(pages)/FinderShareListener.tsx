"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { finderShareAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { FinderShareChoosing } from "@/app/lib/tauri/shares";
import { registerTauriListeners } from "@/lib/utils/tauriListeners";

/**
 * Invisible component that opens the share chooser for a "Share with Hippius"
 * click from the macOS Finder right-click menu.
 *
 * The backend no longer mints on click (the public/private decision moved into
 * the app): it parks the resolved path and emits a single `finder:share-choosing`
 * event with the request `id` + display `name`. This listener does no minting —
 * it just drives `finderShareAtom` into the `choosing` state so `ShareFileModal`
 * shows the picker. From there the modal owns the confirm/cancel IPC and the
 * running → done/error lifecycle, so a Finder share and an in-app share present
 * identically.
 *
 * This event only ever fires on macOS once a click has been dispatched, so the
 * listener is safe to mount unconditionally on every platform — elsewhere it
 * simply never receives one.
 */
export default function FinderShareListener() {
  const setFinderShare = useSetAtom(finderShareAtom);

  useEffect(() => {
    const { cleanup } = registerTauriListeners([
      [
        "finder:share-choosing",
        (event) => {
          const { id, name, sizeBytes, modifiedSecsAgo } =
            event.payload as FinderShareChoosing;
          setFinderShare({
            kind: "choosing",
            id,
            name,
            // `?? null` rather than a default: an older backend that does not
            // send these leaves the chooser showing no size, which is what it
            // showed before. Never invent a 0 — it would read as an empty file.
            sizeBytes: sizeBytes ?? null,
            modifiedSecsAgo: modifiedSecsAgo ?? null,
          });
        },
      ],
    ]);
    return cleanup;
  }, [setFinderShare]);

  return null;
}
