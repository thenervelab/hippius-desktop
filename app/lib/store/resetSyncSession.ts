import { appStore } from "@/lib/store/jotaiStore";
import {
  pendingConflictsAtom,
  failedFilesAtom,
  creditsExhaustedAtom,
  syncEngineHealthAtom,
  DEFAULT_SYNC_ENGINE_HEALTH,
} from "@/lib/store/syncAtoms";
import {
  driveStatusesAtom,
  driveStatusesLoadedAtom,
  metadataStaleLabelsAtom,
  syncRequiresReauthAtom,
} from "@/lib/global-atoms/unpinAtoms";

/**
 * Reset every session-scoped sync atom to its initial value.
 *
 * These atoms live in the module-level `appStore`, which is mounted ABOVE the
 * auth boundary (`<JotaiProvider store={appStore}>` wraps `WalletAuthProvider`
 * and the protected layout). Logout is a client navigation, not a page reload,
 * so unmounting the listener components does NOT clear the atom values — they
 * survive into the next account's session. Without this reset the previous
 * account's drive statuses, repeatedly-failed-files modal, pending conflicts,
 * credits-exhausted banner, and sync-engine health all leak across an
 * account switch.
 *
 * `driveStatusesLoadedAtom` is reset to `false` specifically so
 * `hasConfiguredDrivesAtom` returns to its cold-start "treat as configured"
 * state instead of evaluating against the previous account's stale (or empty)
 * map before the new account's `get_all_drive_statuses` fetch resolves
 * (the F18 stale-map bug).
 *
 * Call on logout and on a boot-time "not authenticated" restore.
 */
export function resetSyncSession(): void {
  appStore.set(pendingConflictsAtom, new Map());
  appStore.set(failedFilesAtom, null);
  appStore.set(creditsExhaustedAtom, null);
  appStore.set(syncEngineHealthAtom, DEFAULT_SYNC_ENGINE_HEALTH);
  appStore.set(driveStatusesAtom, new Map());
  appStore.set(driveStatusesLoadedAtom, false);
  appStore.set(metadataStaleLabelsAtom, new Map());
  appStore.set(syncRequiresReauthAtom, false);
}
