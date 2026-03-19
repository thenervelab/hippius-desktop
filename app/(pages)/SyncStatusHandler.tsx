"use client";

import React, { useState, useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { listen } from "@tauri-apps/api/event";

import SyncStatusDialog from "./SyncStatusDialog";
import { useSyncSnapshot } from "../lib/hooks/useSyncSnapshot";
import {
  isSyncingAtom,
  syncActionCountsAtom,
  hasSyncErrorAtom,
} from "../lib/store/syncAtoms";

const SyncStatusHandler: React.FC = () => {
  const snapshot = useSyncSnapshot();
  const [isSyncOpen, setIsSyncOpen] = useState(false);
  const [isPermanentlyClosed, setIsPermanentlyClosed] = useState(false);

  const isSyncingFromEvents = useAtomValue(isSyncingAtom);
  const syncActionCounts = useAtomValue(syncActionCountsAtom);
  const hasSyncError = useAtomValue(hasSyncErrorAtom);

  // Track the session file count when user dismissed, so we can detect new files
  const dismissedFileCountRef = useRef<number | null>(null);

  const hasFilesToDisplay = snapshot.files.length > 0;
  const isActive = snapshot.isActive;
  const isCompleted =
    !snapshot.isActive &&
    (snapshot.completedFiles > 0 || snapshot.failedFiles > 0);
  const hasFailedFiles = snapshot.failedFiles > 0 || hasSyncError;
  const hasAnyActivity =
    isActive || isSyncingFromEvents || hasFilesToDisplay;

  useEffect(() => {
    const hasSyncCompleted =
      isCompleted && snapshot.overallPercent === 100;

    // Don't reopen if user explicitly closed — only the hcfs_sync_started
    // event listener (which checks for totalExpected > 0) can reset this.
    if (isPermanentlyClosed) {
      const dismissedCount = dismissedFileCountRef.current;
      const hasNewFiles =
        dismissedCount !== null &&
        snapshot.files.length > dismissedCount;

      if (hasNewFiles && hasAnyActivity) {
        dismissedFileCountRef.current = null;
        setIsPermanentlyClosed(false);
        setIsSyncOpen(true);
      }
      return;
    }

    // Show widget when there's activity, files, completed sync, or errors
    if (
      hasAnyActivity ||
      hasFilesToDisplay ||
      hasSyncCompleted ||
      hasFailedFiles
    ) {
      setIsSyncOpen(true);
    }

    // Auto-close when no activity, not completed, no errors, no files
    if (
      !hasAnyActivity &&
      !isCompleted &&
      !hasFailedFiles &&
      isSyncOpen &&
      !hasFilesToDisplay
    ) {
      setIsSyncOpen(false);
    }
  }, [
    isActive,
    isCompleted,
    hasAnyActivity,
    hasFilesToDisplay,
    hasFailedFiles,
    isSyncingFromEvents,
    isPermanentlyClosed,
    isSyncOpen,
    snapshot.overallPercent,
    snapshot.files.length,
  ]);

  // Listen for explicit sync stop/start events
  useEffect(() => {
    let cancelled = false;
    let unsubStop: (() => void) | null = null;
    let unsubStart: (() => void) | null = null;

    listen("hcfs_sync_stopped", () => {
      if (!cancelled) {
        setIsSyncOpen(false);
      }
    })
      .then((u) => {
        if (cancelled) {
          u();
        } else {
          unsubStop = u;
        }
      })
      .catch((err) => {
        console.warn(
          "[SyncStatusHandler] Failed to listen for sync_stopped:",
          err
        );
      });

    listen<{
      uploads?: number;
      downloads?: number;
      local_deletes?: number;
      remote_deletes?: number;
    }>("hcfs_sync_started", (event) => {
      if (!cancelled) {
        const payload = event.payload || {};
        const totalExpected =
          (payload.uploads || 0) +
          (payload.downloads || 0) +
          (payload.local_deletes || 0) +
          (payload.remote_deletes || 0);

        if (totalExpected > 0) {
          dismissedFileCountRef.current = null;
          setIsPermanentlyClosed(false);
          setIsSyncOpen(true);
        }
      }
    })
      .then((u) => {
        if (cancelled) {
          u();
        } else {
          unsubStart = u;
        }
      })
      .catch((err) => {
        console.warn(
          "[SyncStatusHandler] Failed to listen for sync_started:",
          err
        );
      });

    return () => {
      cancelled = true;
      unsubStop?.();
      unsubStart?.();
    };
  }, []);

  // Handle manual close
  const handleClose = () => {
    setIsSyncOpen(false);
    setIsPermanentlyClosed(true);
    dismissedFileCountRef.current = snapshot.files.length;
  };

  // Hide if permanently closed
  if (isPermanentlyClosed) {
    return null;
  }

  // Hide if nothing to show
  if (!hasAnyActivity && !isCompleted && !hasFailedFiles) {
    return null;
  }

  return (
    <SyncStatusDialog
      snapshot={snapshot}
      open={isSyncOpen || hasAnyActivity}
      onClose={handleClose}
      actionCounts={syncActionCounts}
    />
  );
};

export default SyncStatusHandler;
