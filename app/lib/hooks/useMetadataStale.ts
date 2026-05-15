"use client";

/**
 * Mirror Rust's per-drive "metadata stale" state.
 *
 * Rust's `spawn_reconcile_timestamps` (in `sync/lifecycle.rs`) emits
 * `hcfs_metadata_stale` when its bounded-retry reconcile fails for a
 * drive — typically because the server was unreachable across all
 * attempts at drive registration. The drive itself stays usable; only
 * the "DATE UPLOADED" column may be sparse until a later sync cycle
 * backfills it.
 *
 * The banner self-clears when the same drive next emits
 * `hcfs_activity_updated`. `ACTIVITY_UPDATED` fires after any
 * successful manifest fetch (including a sync cycle's own
 * `fetch_remote_state`), so the staleness assumption inverts
 * automatically — no explicit "retry succeeded" event needed.
 *
 * Mount this hook exactly once at the protected layout root via
 * `SyncEventLogger`. It owns `metadataStaleLabelsAtom` — frontend
 * code must never mutate that atom directly.
 */

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { listen } from "@tauri-apps/api/event";
import { metadataStaleLabelsAtom } from "@/app/lib/global-atoms/unpinAtoms";

const METADATA_STALE = "hcfs_metadata_stale";
const ACTIVITY_UPDATED = "hcfs_activity_updated";

interface MetadataStalePayload {
  label: string;
  reason: string;
}

export function useMetadataStale() {
  const setStale = useSetAtom(metadataStaleLabelsAtom);

  useEffect(() => {
    let cancelled = false;
    let unlistenStale: (() => void) | null = null;
    let unlistenActivity: (() => void) | null = null;

    (async () => {
      // 1. METADATA_STALE — add the label with the failure reason.
      const staleHandle = await listen<MetadataStalePayload>(
        METADATA_STALE,
        (event) => {
          if (cancelled) return;
          setStale((prev) => {
            const next = new Map(prev);
            next.set(event.payload.label, event.payload.reason);
            return next;
          });
        }
      );
      if (cancelled) {
        staleHandle();
        return;
      }
      unlistenStale = staleHandle;

      // 2. ACTIVITY_UPDATED — clear the stale entry for any label whose
      //    activity changed. The Rust event currently has no payload
      //    (it's a "kick" signal), so we conservatively clear the
      //    entire map. In practice only a successful reconcile or sync
      //    cycle emits this, so clearing all entries on any kick is
      //    the right behavior: each cleared entry will re-fire its
      //    METADATA_STALE event on the next bounded-retry failure.
      const activityHandle = await listen(ACTIVITY_UPDATED, () => {
        if (cancelled) return;
        setStale((prev) => {
          if (prev.size === 0) return prev;
          return new Map();
        });
      });
      if (cancelled) {
        activityHandle();
        return;
      }
      unlistenActivity = activityHandle;
    })();

    return () => {
      cancelled = true;
      if (unlistenStale) unlistenStale();
      if (unlistenActivity) unlistenActivity();
    };
  }, [setStale]);
}
