"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { emptyRemoteDrivesAtom } from "@/lib/store/syncAtoms";
import { registerTauriListeners } from "@/lib/utils/tauriListeners";
import {
  EMPTY_REMOTE_EVENTS,
  getEmptyRemoteDrives,
  type EmptyRemoteDrive,
  type EmptyRemoteLabelPayload,
} from "@/app/lib/tauri/emptyRemote";
import { applyCleared, applyHeld, applyHydration } from "@/app/lib/emptyRemote/drives";

/**
 * Keeps `emptyRemoteDrivesAtom` in step with Rust: listens for the prompt's
 * events, then hydrates from `get_empty_remote_drives` (app start or
 * reload). Rust emits each event only when something changed, so the read
 * waits until every listener is registered, and a drive an event changed
 * while the read was in flight keeps what the event made of it.
 *
 * Mount once, in `SyncEventLogger`. `resetSyncSession` empties the atom on
 * logout.
 */
export function useEmptyRemoteDrives(): void {
  const setDrives = useSetAtom(emptyRemoteDrivesAtom);

  useEffect(() => {
    let cancelled = false;
    const eventLabels = new Set<string>();

    const hydrate = async (): Promise<void> => {
      eventLabels.clear();
      const drives = await getEmptyRemoteDrives();
      if (cancelled) return;
      const raced = new Set(eventLabels);
      setDrives((prev) => applyHydration(prev, drives, raced));
    };

    const { cleanup, ready } = registerTauriListeners([
      [
        EMPTY_REMOTE_EVENTS.held,
        (event) => {
          const payload = event.payload as EmptyRemoteDrive;
          eventLabels.add(payload.label);
          setDrives((prev) => applyHeld(prev, payload));
        },
      ],
      [
        EMPTY_REMOTE_EVENTS.cleared,
        (event) => {
          const { label } = event.payload as EmptyRemoteLabelPayload;
          eventLabels.add(label);
          setDrives((prev) => applyCleared(prev, label));
        },
      ],
    ]);

    ready
      .then(() => (cancelled ? undefined : hydrate()))
      .catch((err) => {
        // Not fatal: the next prompt event fills the banner in.
        console.warn("[EmptyRemote] Could not read the empty drives:", err);
      });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [setDrives]);
}
