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
  useEffect(() => {
    if (isCompleted && !latchedComplete) {
      setLatchedComplete(true);
      latchedSnapshotRef.current = snapshot;
    }
    // Unlatch when a new meaningful sync starts (active with real files)
    if (isActive && snapshot.totalFiles > 0 && latchedComplete) {
      setLatchedComplete(false);
    }
  }, [isCompleted, isActive, snapshot.totalFiles, latchedComplete, snapshot]);

  const shouldShow =
    (isActive && snapshot.totalFiles > 0) ||
    isCompleted ||
    isRetrying ||
    latchedComplete;

  // Use the latched snapshot for rendering when in latched state,
  // otherwise use the live snapshot.
  const displaySnapshot =
    latchedComplete && !isCompleted && !(isActive && snapshot.totalFiles > 0)
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

    // Re-open during active state if session or file count changed
    if (isActive && snapshot.totalFiles > 0) {
      const isDifferentTotal = snapshot.totalFiles !== dismissedTotalRef.current;
      if (isNewSession || isDifferentTotal) {
        setIsDismissed(false);
        setLatchedComplete(false);
      }
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
