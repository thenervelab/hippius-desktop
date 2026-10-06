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
  holdKey,
} from "@/app/lib/massDelete/holds";
import { restoredToastCopy } from "@/app/lib/massDelete/copy";

/**
 * Keeps `massDeleteHoldsAtom` in step with Rust: listens for the hold
 * events, then hydrates from `get_mass_delete_holds` (app start or reload,
 * when the events of earlier cycles are gone). Rust emits each event only
 * when something changed, so one emitted before its listener existed would
 * be lost for good; the read waits until every listener is registered.
 *
 * Mount once, in `SyncEventLogger`. `resetSyncSession` empties the atom on
 * logout.
 */
export function useMassDeleteHolds(): void {
  const setHolds = useSetAtom(massDeleteHoldsAtom);

  useEffect(() => {
    let cancelled = false;
    // Sides an event changed while the current hydration read is in flight.
    // The event is newer than the read for them: read again, and when the
    // re-reads run out, apply the read to every other side only.
    const eventKeys = new Set<string>();

    const hydrate = async (attemptsLeft: number): Promise<void> => {
      eventKeys.clear();
      const holds = await getMassDeleteHolds();
      if (cancelled) return;
      if (eventKeys.size > 0 && attemptsLeft > 0) {
        await hydrate(attemptsLeft - 1);
        return;
      }
      const raced = new Set(eventKeys);
      setHolds((prev) => applyHydration(prev, holds, raced));
    };

    const apply = (payload: MassDeleteSidePayload, update: Parameters<typeof setHolds>[0]) => {
      eventKeys.add(holdKey(payload.label, payload.side));
      setHolds(update);
    };

    const { cleanup, ready } = registerTauriListeners([
      [
        MASS_DELETE_EVENTS.held,
        (event) => {
          const payload = event.payload as MassDeleteHold;
          apply(payload, (prev) => applyHeld(prev, payload));
        },
      ],
      [
        MASS_DELETE_EVENTS.cleared,
        (event) => {
          const payload = event.payload as MassDeleteSidePayload;
          apply(payload, (prev) => applyCleared(prev, payload));
        },
      ],
      [
        MASS_DELETE_EVENTS.restored,
        (event) => {
          const payload = event.payload as MassDeleteRestoredPayload;
          apply(payload, (prev) => applyRestored(prev, payload));
          const copy = restoredToastCopy(payload.label, payload.side, payload);
          toast.success(copy.title, { description: copy.description, duration: 8000 });
        },
      ],
      [
        MASS_DELETE_EVENTS.restoreRefused,
        (event) => {
          const payload = event.payload as MassDeleteRestoreRefusedPayload;
          apply(payload, (prev) => applyRefused(prev, payload));
        },
      ],
    ]);

    ready
      .then(() => (cancelled ? undefined : hydrate(2)))
      .catch((err) => {
        // Not fatal: the next hold event fills the prompt in.
        console.warn("[MassDelete] Could not read the held deletes:", err);
      });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [setHolds]);
}
