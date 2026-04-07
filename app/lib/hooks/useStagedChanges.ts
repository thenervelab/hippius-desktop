"use client";

import { useState, useCallback, useEffect } from "react";
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
      await invoke("cancel_review");
    } catch (e) {
      console.error("Failed to cancel review:", e);
    }
    setStagedChanges(null);
    setError(null);
  }, []);

  // Safety net: cancel review on unmount (no-op if not in review mode — Rust handles it)
  useEffect(() => {
    return () => {
      invoke("cancel_review").catch(() => {});
    };
  }, []);

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
