import { useEffect, useRef } from "react";
import { useSyncSnapshot } from "./useSyncSnapshot";

/**
 * Invoke `refresh` on a modest interval WHILE a sync is actively in progress,
 * and once more on the active→idle edge.
 *
 * Used by the local-sync-folder cards (the Files/Drive page's `DriveOnboarding`
 * and Settings' `MultiFolderSyncManager`) to keep each folder's size + file
 * count climbing as uploads land. Those numbers are each drive's server-side
 * remote-folder totals (a live `list_remote_folders` call), which grow as files
 * commit — but the cards otherwise only fetch them on mount + explicit user
 * actions, so they sat frozen for the whole sync and a freshly-added folder
 * showed no stats at all.
 *
 * The caller's `refresh` MUST be silent (must not toggle a loading skeleton),
 * or the card flashes its skeleton on every poll (the storage-card flicker
 * class of bug). `refresh` is read through a ref so a changing callback identity
 * never tears down / restarts the live interval mid-sync.
 *
 * Cadence note: 6s mirrors the home Storage tile's live-refresh and only runs
 * while `active && enabled`, so an idle page makes zero extra network calls.
 *
 * @param refresh     re-fetch callback (should be silent)
 * @param enabled     gate, e.g. an account address is present
 * @param intervalMs  poll cadence while active (default 6000)
 */
export function useRefreshWhileSyncing(
  refresh: () => void,
  enabled: boolean,
  intervalMs = 6000,
): void {
  const snapshot = useSyncSnapshot();
  const active = snapshot.effectiveInProgress;

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Poll while a sync is running.
  useEffect(() => {
    if (!enabled || !active) return;
    const id = setInterval(() => refreshRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [enabled, active, intervalMs]);

  // One final refresh when the sync settles, to land the completed totals.
  const prevActiveRef = useRef(false);
  useEffect(() => {
    if (prevActiveRef.current && !active && enabled) {
      refreshRef.current();
    }
    prevActiveRef.current = active;
  }, [active, enabled]);
}
