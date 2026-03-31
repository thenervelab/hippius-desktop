"use client";

import { useEffect } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EMPTY_SNAPSHOT, type SyncSnapshot } from "../types/syncSnapshot";

export const snapshotAtom = atom<SyncSnapshot>(EMPTY_SNAPSHOT);

/**
 * Listens for push-based sync progress snapshots from the Rust backend.
 *
 * Mount once at the app root. Rust emits "sync_progress_snapshot" events
 * on state changes (throttled to 250ms for byte updates, immediate for
 * status transitions). No polling needed.
 */
export function useSyncSnapshotListener() {
  const setSnapshot = useSetAtom(snapshotAtom);

  useEffect(() => {
    let cancelled = false;

    invoke<SyncSnapshot>("sp_get_snapshot")
      .then((snapshot) => {
        if (!cancelled) setSnapshot(snapshot);
      })
      .catch((err) => {
        console.error("[SyncSnapshot] Failed to get initial snapshot:", err);
      });

    let unsubFn: (() => void) | null = null;

    listen<SyncSnapshot>("sync_progress_snapshot", (e) => {
      if (!cancelled) setSnapshot(e.payload);
    })
      .then((unsub) => {
        if (cancelled) {
          unsub();
        } else {
          unsubFn = unsub;
        }
      })
      .catch((err) => {
        console.error("[SyncSnapshot] Failed to listen:", err);
      });

    return () => {
      cancelled = true;
      unsubFn?.();
    };
  }, [setSnapshot]);
}

/**
 * Read-only hook to access the current sync snapshot.
 */
export function useSyncSnapshot(): SyncSnapshot {
  return useAtomValue(snapshotAtom);
}
