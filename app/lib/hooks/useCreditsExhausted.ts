"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import {
  creditsExhaustedAtom,
  type CreditsExhaustedInfo,
} from "@/lib/store/syncAtoms";
import { registerTauriListeners } from "@/lib/utils/tauriListeners";

/**
 * Subscribes to the `hcfs_credits_exhausted` Tauri event and writes
 * payloads into `creditsExhaustedAtom`, the single source of truth for
 * the `CreditsExhaustedBanner`.
 *
 * Auto-dismiss policy: a fresh `hcfs_sync_started` event clears the
 * atom (and therefore the banner) so a new cycle starts with no stale
 * 402 banner from a previous one. The user can also dismiss manually
 * — that path lives in the banner component (it sets the atom to
 * `null`). Either way, a subsequent 402 in a new cycle re-raises the
 * banner, matching the per-cycle ephemerality contract documented in
 * `syncAtoms.ts`.
 *
 * Mount once at the top of the authenticated layout (alongside
 * `SyncEventLogger`). Multiple mounts would duplicate the listeners
 * and write the atom twice per event — annoying but not incorrect;
 * still, prefer a single mount.
 */
export function useCreditsExhausted(): void {
  const setCreditsExhausted = useSetAtom(creditsExhaustedAtom);

  useEffect(() => {
    const { cleanup } = registerTauriListeners([
      [
        "hcfs_credits_exhausted",
        (event) => {
          // Payload is shaped by the Rust `CreditsExhaustedPayload`
          // (camelCase via serde). Trust the wire format; the Rust
          // side has a regression test
          // (`payload_serialises_to_camel_case_json`) pinning it.
          setCreditsExhausted(event.payload as CreditsExhaustedInfo);
        },
      ],
      [
        "hcfs_sync_started",
        () => {
          // A fresh cycle for any drive clears the banner. The next
          // 402 in this or another drive's cycle will re-raise it
          // with `fileCount = 1` (the Rust bridge clears its running
          // counter on `SyncStarted`, so the values stay consistent).
          setCreditsExhausted(null);
        },
      ],
    ]);

    return cleanup;
  }, [setCreditsExhausted]);
}
