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
  // Bridge the gap between sync_started and on_sync_plan_ready —
  // during this window no session exists yet so isActive is false.
  const [isPreparing, setIsPreparing] = useState(false);
  // Track whether the widget is already visible so we can suppress
  // redundant isPreparing toggles during no-op heartbeat cycles.
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

  // Clear preparing flag once the snapshot has an active session
  useEffect(() => {
    if (isPreparing && isActive) {
      setIsPreparing(false);
    }
  }, [isPreparing, isActive]);

  const shouldShow =
    isActive ||
    isCompleted ||
    isRetrying ||
    latchedComplete ||
    isPreparing;

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

    // sync_started: show widget in "Preparing" state before files are known.
    // Only set isPreparing when the widget is NOT already visible — this
    // prevents redundant re-render cycles during no-op heartbeat cycles
    // (~30s) that would cause flicker via transition-all animations.
    // When the widget is already showing (e.g. latched completed state),
    // isPreparing is unnecessary since the snapshot update from
    // on_sync_plan_ready will transition the display naturally.
    listen("hcfs_sync_started", () => {
      if (!cancelled && !shouldShowRef.current) {
        setIsPreparing(true);
      }
    })
      .then((u) => { if (cancelled) u(); else unsubs.push(u); })
      .catch(() => {});

    // sync_completed: clear preparing (handles no-op cycles)
    listen("hcfs_sync_completed", () => {
      if (!cancelled) {
        setIsPreparing(false);
      }
    })
      .then((u) => { if (cancelled) u(); else unsubs.push(u); })
      .catch(() => {});

    // sync_error: clear preparing so the widget doesn't stay stuck
    // in "Preparing sync..." when sync fails before a session is created
    listen("hcfs_sync_error", () => {
      if (!cancelled) {
        setIsPreparing(false);
      }
    })
      .then((u) => { if (cancelled) u(); else unsubs.push(u); })
      .catch(() => {});

    // sync_stopped (user-initiated): dismiss widget entirely
    listen("hcfs_sync_stopped", () => {
      if (!cancelled) {
        setIsDismissed(true);
        setLatchedComplete(false);
        setIsPreparing(false);
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
    setIsPreparing(false);
  }, [snapshot.totalFiles, snapshot.startedAt]);

  if (!shouldShow || isDismissed) {
    return null;
  }

  return (
    <SyncStatusDialog
      snapshot={displaySnapshot}
      open={shouldShow}
      onClose={handleClose}
      isPreparing={isPreparing && !isActive}
    />
  );
};

export default SyncStatusHandler;
