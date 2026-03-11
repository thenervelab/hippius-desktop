"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StagedChanges, ConflictResolution } from "@/lib/types/syncTypes";

export function useStagedChanges() {
  const [stagedChanges, setStagedChanges] = useState<StagedChanges | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track whether we have an active review mode so we can clean up on unmount
  const reviewActiveRef = useRef(false);

  const fetchStagedChanges = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const changes = await invoke<StagedChanges>("stage_changes");
      setStagedChanges(changes);
      reviewActiveRef.current = true;
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
        reviewActiveRef.current = false;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        reviewActiveRef.current = false;
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
    reviewActiveRef.current = false;
  }, []);

  // Safety net: if the component unmounts while review mode is active,
  // cancel review to prevent SYNC_REVIEW_MODE from staying stuck.
  useEffect(() => {
    return () => {
      if (reviewActiveRef.current) {
        invoke("cancel_review").catch((err: unknown) => console.warn("[useStagedChanges] cancel_review failed on unmount:", err));
      }
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
