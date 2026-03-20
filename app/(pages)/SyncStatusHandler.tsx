"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";

import SyncStatusDialog from "./SyncStatusDialog";
import { useSyncSnapshot } from "../lib/hooks/useSyncSnapshot";

/** Milliseconds after completion before auto-hiding the widget. */
const AUTO_HIDE_DELAY_MS = 8_000;

const SyncStatusHandler: React.FC = () => {
  const snapshot = useSyncSnapshot();
  const [isDismissed, setIsDismissed] = useState(false);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isActive = snapshot.isActive;
  const isRetrying = !snapshot.isActive && snapshot.retryInSecs > 0;
  const isCompleted =
    !snapshot.isActive &&
    !isRetrying &&
    (snapshot.completedFiles > 0 || snapshot.failedFiles > 0);
  const hasFailed = snapshot.failedFiles > 0 || isRetrying;

  const shouldShow =
    isActive ||
    isCompleted ||
    isRetrying ||
    snapshot.files.length > 0;

  // Auto-reopen when new sync activity starts after dismissal
  useEffect(() => {
    if (!isDismissed) return;
    if (isActive && snapshot.totalFiles > 0) {
      setIsDismissed(false);
    }
  }, [isDismissed, isActive, snapshot.totalFiles]);

  // Auto-hide after successful completion (no errors)
  useEffect(() => {
    if (autoHideTimerRef.current) {
      clearTimeout(autoHideTimerRef.current);
      autoHideTimerRef.current = null;
    }

    if (isCompleted && !hasFailed) {
      autoHideTimerRef.current = setTimeout(() => {
        autoHideTimerRef.current = null;
        setIsDismissed(true);
      }, AUTO_HIDE_DELAY_MS);
    }

    return () => {
      if (autoHideTimerRef.current) {
        clearTimeout(autoHideTimerRef.current);
      }
    };
  }, [isCompleted, hasFailed]);

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
