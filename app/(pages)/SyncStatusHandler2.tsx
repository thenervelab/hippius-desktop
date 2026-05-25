"use client";

import React, { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useSyncSnapshot } from "../lib/hooks/useSyncSnapshot";
import { registerTauriListeners } from "../lib/utils/tauriListeners";
import SyncStatusDialog2 from "./SyncStatusDialog2";

/**
 * Sync status widget handler.
 *
 * All visibility and latching logic is now in Rust (via widget_visible
 * and widget_state fields on the snapshot). This component just renders
 * based on those fields and dispatches user actions (dismiss) to Rust.
 */
const SyncStatusHandler2: React.FC = () => {
  const snapshot = useSyncSnapshot();

  // Listen for sync_stopped to dismiss widget
  useEffect(() => {
    const { cleanup } = registerTauriListeners([
      [
        "hcfs_sync_stopped",
        () => {
          invoke("sp_dismiss_sync_widget").catch(() => {});
        },
      ],
    ]);

    return cleanup;
  }, []);

  const handleClose = useCallback(() => {
    invoke("sp_dismiss_sync_widget").catch(() => {});
  }, []);

  if (!snapshot.widgetVisible) {
    return null;
  }

  return (
    <SyncStatusDialog2
      snapshot={snapshot}
      open={snapshot.widgetVisible}
      onClose={handleClose}
    />
  );
};

export default SyncStatusHandler2;
