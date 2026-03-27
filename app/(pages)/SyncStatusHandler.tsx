"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

import SyncStatusDialog from "./SyncStatusDialog";
import { useSyncSnapshot } from "../lib/hooks/useSyncSnapshot";

const SyncStatusHandler: React.FC = () => {
  const snapshot = useSyncSnapshot();
  const [isDismissed, setIsDismissed] = useState(false);
  // Track the totalFiles value when user dismissed, so we can detect new activity
  const dismissedTotalRef = useRef(0);
  // Latch the completed/failed state so widget stays visible even after
  // the backend starts a new empty sync cycle and resets the snapshot.
  const [latchedComplete, setLatchedComplete] = useState(false);
  const latchedSnapshotRef = useRef(snapshot);
  // Track whether the widget is currently rendered so event listeners
  // can check visibility without triggering re-renders.
  const shouldShowRef = useRef(false);

  const isActive = snapshot.isActive;
  const isRetrying = !snapshot.isActive && snapshot.retryInSecs > 0;
  const isCompleted =
    !snapshot.isActive &&
    !isRetrying &&
    (snapshot.completedFiles > 0 || snapshot.failedFiles > 0);

  // Latch: when we first detect completion, capture it so a subsequent
  // snapshot reset (new empty cycle) doesn't hide the widget.
  // Unlatch when a new session starts (different startedAt while active).
  useEffect(() => {
    if (isCompleted && !latchedComplete) {
      setLatchedComplete(true);
      latchedSnapshotRef.current = snapshot;
    }
    // Unlatch when a NEW session becomes active AND has real files.
    // The sync loop creates empty sessions (totalFiles=0) between real
    // sync cycles — unlatching for those would flash the widget away
    // before the next no-op cycle completes with 0 files (hiding it).
    if (
      isActive &&
      latchedComplete &&
      snapshot.startedAt !== null &&
      snapshot.startedAt !== latchedSnapshotRef.current.startedAt &&
      snapshot.totalFiles > 0
    ) {
      setLatchedComplete(false);
    }
  }, [isCompleted, isActive, snapshot.totalFiles, snapshot.startedAt, latchedComplete, snapshot]);

  // Only show when there's real content — active session with files,
  // completed/failed results, retrying, or latched completed state.
  // Never show for empty heartbeat cycles (totalFiles=0, not completed).
  const shouldShow =
    (isActive && snapshot.totalFiles > 0) ||
    isCompleted ||
    isRetrying ||
    latchedComplete;

  // Keep the ref in sync so event listeners can check visibility
  // without triggering re-renders. Track actual rendering state
  // (not just shouldShow) so dismissed widgets are seen as hidden.
  useEffect(() => {
    shouldShowRef.current = shouldShow && !isDismissed;
  }, [shouldShow, isDismissed]);

  // Use the latched snapshot for rendering when in latched state,
  // otherwise use the live snapshot. Only switch to the live snapshot
  // when a genuinely new session has real files — empty sessions
  // (totalFiles=0, created before on_sync_plan_ready) should NOT
  // override the latched display, since they'd cause a brief flicker.
  const isNewSessionWithFiles =
    isActive &&
    snapshot.startedAt !== null &&
    snapshot.startedAt !== latchedSnapshotRef.current.startedAt &&
    snapshot.totalFiles > 0;

  const displaySnapshot =
    latchedComplete && !isCompleted && !isNewSessionWithFiles
      ? latchedSnapshotRef.current
      : snapshot;

  // Track the startedAt of the session that was dismissed, to detect new cycles
  const dismissedStartedAtRef = useRef<number | null>(null);

  // Auto-reopen when new sync activity starts after dismissal.
  // Checks both active and completed states because fast operations (e.g. deletes)
  // can complete before React renders the active state.
  useEffect(() => {
    if (!isDismissed) return;

    const isNewSession =
      snapshot.startedAt !== null &&
      snapshot.startedAt !== dismissedStartedAtRef.current;

    // Re-open during active state if this is a new session with real files
    if (isActive && isNewSession && snapshot.totalFiles > 0) {
      setIsDismissed(false);
      setLatchedComplete(false);
    }

    // Re-open for a completed session we haven't seen yet (fast ops like deletes)
    if (isCompleted && isNewSession) {
      setIsDismissed(false);
    }
  }, [isDismissed, isActive, isCompleted, snapshot.totalFiles, snapshot.startedAt]);

  // Listen for sync lifecycle events
  useEffect(() => {
    let cancelled = false;
    const unsubs: (() => void)[] = [];

    // sync_stopped (user-initiated): dismiss widget entirely
    listen("hcfs_sync_stopped", () => {
      if (!cancelled) {
        setIsDismissed(true);
        setLatchedComplete(false);
        dismissedTotalRef.current = 0;
      }
    })
      .then((u) => { if (cancelled) u(); else unsubs.push(u); })
      .catch((err) => {
        console.warn(
          "[SyncStatusHandler] Failed to listen for sync_stopped:",
          err
        );
      });

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, []);

  const handleClose = useCallback(() => {
    dismissedTotalRef.current = snapshot.totalFiles;
    dismissedStartedAtRef.current = snapshot.startedAt;
    setIsDismissed(true);
    setLatchedComplete(false);
  }, [snapshot.totalFiles, snapshot.startedAt]);

  if (!shouldShow || isDismissed) {
    return null;
  }

  return (
    <SyncStatusDialog
      snapshot={displaySnapshot}
      open={shouldShow}
      onClose={handleClose}
    />
  );
};

export default SyncStatusHandler;
