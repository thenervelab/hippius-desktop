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

// Mirror of Rust's `events::LabelPayload`. ACTIVITY_UPDATED now carries the
// drive label (F35). Optional so a legacy label-less event degrades safely.
interface LabelPayload {
  label?: string;
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

      // 2. ACTIVITY_UPDATED — clear the stale entry for the one drive whose
      //    activity changed (F35). The Rust event now carries the drive
      //    `label`, so a successful reconcile/sync for drive B no longer
      //    wipes drive A's banner; if a label re-enters the stale state it
      //    re-fires its own METADATA_STALE on the next bounded-retry
      //    failure. Defensive fallback: a label-less event (legacy/untyped)
      //    clears the whole map so a banner can't get stuck.
      const activityHandle = await listen<LabelPayload>(
        ACTIVITY_UPDATED,
        (event) => {
          if (cancelled) return;
          const label = event.payload?.label;
          setStale((prev) => {
            if (prev.size === 0) return prev;
            if (label === undefined) return new Map();
            if (!prev.has(label)) return prev;
            const next = new Map(prev);
            next.delete(label);
            return next;
          });
        }
      );
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
