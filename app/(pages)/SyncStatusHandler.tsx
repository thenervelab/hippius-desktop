"use client";

import React, { useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import SyncStatusDialog from "./SyncStatusDialog";
import { useSyncSnapshot } from "../lib/hooks/useSyncSnapshot";

/**
 * Sync status widget handler.
 *
 * All visibility and latching logic is now in Rust (via widget_visible
 * and widget_state fields on the snapshot). This component just renders
 * based on those fields and dispatches user actions (dismiss) to Rust.
 */
const SyncStatusHandler: React.FC = () => {
  const snapshot = useSyncSnapshot();

  // Listen for sync_stopped to dismiss widget
  useEffect(() => {
    let cancelled = false;
    const unsubs: (() => void)[] = [];

    listen("hcfs_sync_stopped", () => {
      if (!cancelled) {
        invoke("sp_dismiss_sync_widget").catch(() => {});
      }
    })
      .then((u) => { if (cancelled) u(); else unsubs.push(u); })
      .catch((err) => {
        console.warn("[SyncStatusHandler] Failed to listen for sync_stopped:", err);
      });

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, []);

  const handleClose = useCallback(() => {
    invoke("sp_dismiss_sync_widget").catch(() => {});
  }, []);

  if (!snapshot.widgetVisible) {
    return null;
  }

  return (
    <SyncStatusDialog
      snapshot={snapshot}
      open={snapshot.widgetVisible}
      onClose={handleClose}
    />
  );
};

export default SyncStatusHandler;
