"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { toast } from "sonner";
import { massDeleteHoldsAtom } from "@/lib/store/syncAtoms";
import { registerTauriListeners } from "@/lib/utils/tauriListeners";
import {
  MASS_DELETE_EVENTS,
  getMassDeleteHolds,
  type MassDeleteHold,
  type MassDeleteRestoreRefusedPayload,
  type MassDeleteRestoredPayload,
  type MassDeleteSidePayload,
} from "@/app/lib/tauri/massDelete";
import {
  applyCleared,
  applyHeld,
  applyHydration,
  applyRefused,
  applyRestored,
} from "@/app/lib/massDelete/holds";
import { restoredToastCopy } from "@/app/lib/massDelete/copy";

/**
 * Keeps `massDeleteHoldsAtom` in step with Rust: hydrates from
 * `get_mass_delete_holds` on mount (app start or reload, when the events of
 * earlier cycles are gone), then folds in the hold events. Rust emits each
 * only when something changed, so every event is worth applying.
 *
 * Mount once, in `SyncEventLogger`. `resetSyncSession` empties the atom on
 * logout.
 */
export function useMassDeleteHolds(): void {
  const setHolds = useSetAtom(massDeleteHoldsAtom);

  useEffect(() => {
    let cancelled = false;
    // Events applied while the hydration read was in flight are newer than
    // what it may return; when any arrive, read again rather than let the
    // older answer overwrite them.
    let eventsSeen = 0;

    const hydrate = async (attemptsLeft: number) => {
      const seenBefore = eventsSeen;
      const holds = await getMassDeleteHolds();
      if (cancelled) return;
      if (eventsSeen !== seenBefore && attemptsLeft > 0) {
        await hydrate(attemptsLeft - 1);
        return;
      }
      setHolds((prev) => applyHydration(prev, holds));
    };
    hydrate(2).catch((err) => {
      // Not fatal: the next hold event fills the prompt in.
      console.warn("[MassDelete] Could not read the held deletes:", err);
    });

    const apply = (update: Parameters<typeof setHolds>[0]) => {
      eventsSeen += 1;
      setHolds(update);
    };

    const { cleanup } = registerTauriListeners([
      [
        MASS_DELETE_EVENTS.held,
        (event) => apply((prev) => applyHeld(prev, event.payload as MassDeleteHold)),
      ],
      [
        MASS_DELETE_EVENTS.cleared,
        (event) =>
          apply((prev) => applyCleared(prev, event.payload as MassDeleteSidePayload)),
      ],
      [
        MASS_DELETE_EVENTS.restored,
        (event) => {
          const payload = event.payload as MassDeleteRestoredPayload;
          apply((prev) => applyRestored(prev, payload));
          const copy = restoredToastCopy(payload.label, payload.side, payload);
          toast.success(copy.title, { description: copy.description, duration: 8000 });
        },
      ],
      [
        MASS_DELETE_EVENTS.restoreRefused,
        (event) =>
          apply((prev) => applyRefused(prev, event.payload as MassDeleteRestoreRefusedPayload)),
      ],
    ]);

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [setHolds]);
}
