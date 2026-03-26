"use client";

import React, { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";

import SyncStatusDialog from "./SyncStatusDialog";
import { useSyncSnapshot } from "../lib/hooks/useSyncSnapshot";

const SyncStatusHandler: React.FC = () => {
  const snapshot = useSyncSnapshot();
  const [isDismissed, setIsDismissed] = useState(false);

  const isActive = snapshot.isActive;
  const isRetrying = !snapshot.isActive && snapshot.retryInSecs > 0;
  const isCompleted =
    !snapshot.isActive &&
    !isRetrying &&
    (snapshot.completedFiles > 0 || snapshot.failedFiles > 0);

  const shouldShow =
    (isActive && snapshot.totalFiles > 0) ||
    isCompleted ||
    isRetrying;

  // Auto-reopen when new sync activity starts after dismissal
  useEffect(() => {
    if (!isDismissed) return;
    if (isActive && snapshot.totalFiles > 0) {
      setIsDismissed(false);
    }
  }, [isDismissed, isActive, snapshot.totalFiles]);

  // Listen for explicit sync stop (user-initiated) to dismiss widget
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;

    listen("hcfs_sync_stopped", () => {
      if (!cancelled) {
        setIsDismissed(true);
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
    setIsDismissed(true);
  }, []);

  if (!shouldShow || isDismissed) {
    return null;
  }

  return (
    <SyncStatusDialog
      snapshot={snapshot}
      open={shouldShow}
      onClose={handleClose}
    />
  );
};

export default SyncStatusHandler;
