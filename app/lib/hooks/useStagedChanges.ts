"use client";

import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StagedChanges, ConflictResolution } from "@/lib/types/syncTypes";

export function useStagedChanges() {
  const [stagedChanges, setStagedChanges] = useState<StagedChanges | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStagedChanges = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const changes = await invoke<StagedChanges>("stage_changes");
      setStagedChanges(changes);
      return changes;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const syncWithResolutions = useCallback(
    async (resolutions: Record<string, ConflictResolution>) => {
      setIsSyncing(true);
      setError(null);
      try {
        await invoke("sync_with_conflict_resolutions", { resolutions });
        setStagedChanges(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      } finally {
        setIsSyncing(false);
      }
    },
    []
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
