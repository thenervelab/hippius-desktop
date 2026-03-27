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
    // Unlatch when a NEW session becomes active. Compare startedAt to
    // detect a genuinely new session — the sync loop creates an empty
    // session (totalFiles=0) before on_sync_plan_ready registers files,
    // so checking totalFiles > 0 alone would miss the transition.
    if (
      isActive &&
      latchedComplete &&
      snapshot.startedAt !== null &&
      snapshot.startedAt !== latchedSnapshotRef.current.startedAt
    ) {
      setLatchedComplete(false);
    }
  }, [isCompleted, isActive, snapshot.totalFiles, snapshot.startedAt, latchedComplete, snapshot]);

  const shouldShow =
    isActive ||
    isCompleted ||
    isRetrying ||
    latchedComplete;

  // Use the latched snapshot for rendering when in latched state,
  // otherwise use the live snapshot. If a different session is active
  // (even with 0 files initially), always show the live snapshot.
  const isNewSessionActive =
    isActive &&
    snapshot.startedAt !== null &&
    snapshot.startedAt !== latchedSnapshotRef.current.startedAt;

  const displaySnapshot =
    latchedComplete && !isCompleted && !isNewSessionActive
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

    // Re-open during active state if this is a new session
    if (isActive && isNewSession) {
      setIsDismissed(false);
      setLatchedComplete(false);
    }

    // Re-open for a completed session we haven't seen yet (fast ops like deletes)
    if (isCompleted && isNewSession) {
      setIsDismissed(false);
    }
  }, [isDismissed, isActive, isCompleted, snapshot.totalFiles, snapshot.startedAt]);

  // Listen for explicit sync stop (user-initiated) to dismiss widget
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;

    listen("hcfs_sync_stopped", () => {
      if (!cancelled) {
        setIsDismissed(true);
        setLatchedComplete(false);
        dismissedTotalRef.current = 0;
      }
    })
      .then((u) => {
        if (cancelled) {
          u();
        } else {
          unsub = u;
        }
      })
      .catch((err) => {
        console.warn(
          "[SyncStatusHandler] Failed to listen for sync_stopped:",
          err
        );
      });

    return () => {
      cancelled = true;
      unsub?.();
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
