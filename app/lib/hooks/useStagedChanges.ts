"use client";

import { useState, useCallback } from "react";
import { errorMessage } from "@/lib/utils/errorUtils";
import { isNotReady } from "@/lib/utils/dispatchTauriError";
import { invoke } from "@tauri-apps/api/core";
import type { StagedChanges, ConflictResolution } from "@/lib/types/syncTypes";

/**
 * Outcome of a reviewed sync, so callers can react instead of treating every
 * completion as success (a failed resolve used to close the dialog silently).
 *
 * `syncInProgress` marks the `NotReady(SyncInProgress)` rejection: the
 * auto-sync loop currently holds this drive's manager for an in-flight cycle
 * and the reviewed sync never started — surface it as "retry shortly", not as
 * a failure.
 */
export type SyncWithResolutionsResult =
  | { ok: true }
  | { ok: false; message: string; syncInProgress: boolean };

/**
 * Hook for staging sync changes and resolving conflicts on a specific drive.
 *
 * @param label - The drive label to operate on. Defaults to "default" for
 *   single-drive setups. When multi-drive UI is implemented, callers should
 *   pass the actual drive label from their context.
 */
export function useStagedChanges(
  // TODO: use actual drive label when multi-drive UI is implemented
  label: string = "default"
) {
  const [stagedChanges, setStagedChanges] = useState<StagedChanges | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStagedChanges = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const changes = await invoke<StagedChanges>("stage_changes", { label });
      setStagedChanges(changes);
      return changes;
    } catch (e) {
      const msg = errorMessage(e);
      setError(msg);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [label]);

  const syncWithResolutions = useCallback(
    async (
      resolutions: Record<string, ConflictResolution>
    ): Promise<SyncWithResolutionsResult> => {
      setIsSyncing(true);
      setError(null);
      try {
        await invoke("sync_with_conflict_resolutions", {
          label,
          resolutions,
        });
        setStagedChanges(null);
        return { ok: true };
      } catch (e) {
        const msg = errorMessage(e);
        setError(msg);
        return {
          ok: false,
          message: msg,
          syncInProgress: isNotReady(e, "SYNC_IN_PROGRESS"),
        };
      } finally {
        setIsSyncing(false);
      }
    },
    [label]
  );

  const cancelReview = useCallback(async () => {
    try {
      // Scope the cancel to THIS drive — cancel_review clears only `label`'s
      // review state, not every drive's (which would arm a per-drive cooldown
      // across all of them).
      await invoke("cancel_review", { label });
    } catch (e) {
      console.error("Failed to cancel review:", e);
    }
    setStagedChanges(null);
    setError(null);
  }, [label]);

  // NOTE: cancel-on-unmount is intentionally NOT done here (upstream F16/F42).
  // `cancel_review` arms a per-drive cooldown that suppresses fresh conflict
  // dialogs; firing it on every unmount would re-arm that cooldown after a
  // normal resolution. Explicit dismiss/resolve cancels this drive's review;
  // navigate-away is covered by the engine's 5-minute REVIEW_MODE_TIMEOUT.

  return {
    stagedChanges,
    isLoading,
    isSyncing,
    error,
    fetchStagedChanges,
    syncWithResolutions,
    cancelReview,
  };
}
