"use client";

import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StagedChanges, ConflictResolution } from "@/lib/types/syncTypes";

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
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [label]);

  const syncWithResolutions = useCallback(
    async (resolutions: Record<string, ConflictResolution>) => {
      setIsSyncing(true);
      setError(null);
      try {
        await invoke("sync_with_conflict_resolutions", {
          label,
          resolutions,
        });
        setStagedChanges(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      } finally {
        setIsSyncing(false);
      }
    },
    [label]
  );

  const cancelReview = useCallback(async () => {
    try {
      // Scope the cancel to THIS drive — cancel_review clears only `label`'s
      // review state, not every drive's (which would arm a global cooldown).
      await invoke("cancel_review", { label });
    } catch (e) {
      console.error("Failed to cancel review:", e);
    }
    setStagedChanges(null);
    setError(null);
  }, [label]);

  // NOTE: cancel-on-unmount is intentionally NOT done here. `cancel_review` is
  // a GLOBAL reset (it clears every drive's review and arms a 60s cooldown that
  // suppresses fresh conflict dialogs on ALL drives). Firing it unconditionally
  // on every unmount swallowed conflicts. The sole consumer, `ConflictsBanner`,
  // owns a `reviewActiveRef`-guarded unmount cancel that only runs when a review
  // is genuinely active — so this hook must not duplicate it unguarded.

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
