"use client";

import React, { useEffect, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import SyncStatusDialog from "./SyncStatusDialog";
import { useSyncSnapshot } from "../lib/hooks/useSyncSnapshot";
import { registerTauriListeners } from "../lib/utils/tauriListeners";

interface SyncStatusHandlerProps {
  host?: "portal" | "sidebar";
}

/**
 * Sync status widget handler.
 *
 * All visibility and latching logic is now in Rust (via widget_visible
 * and widget_state fields on the snapshot). This component just renders
 * based on those fields and dispatches user actions (dismiss) to Rust.
 */
const SyncStatusHandler: React.FC<SyncStatusHandlerProps> = ({
  host = "portal",
}) => {
  const snapshot = useSyncSnapshot();
  const [sidebarHostPresent, setSidebarHostPresent] = useState(() => {
    if (typeof document === "undefined") return false;
    return Boolean(
      document.querySelector('[data-sync-widget-sidebar-host="true"]'),
    );
  });

  // Listen for sync_stopped to dismiss widget
  useEffect(() => {
    const { cleanup } = registerTauriListeners([
      ["hcfs_sync_stopped", () => {
        invoke("sp_dismiss_sync_widget").catch(() => {});
      }],
    ]);

    return cleanup;
  }, []);

  const handleClose = useCallback(() => {
    invoke("sp_dismiss_sync_widget").catch(() => {});
  }, []);

  useEffect(() => {
    if (host !== "portal" || typeof document === "undefined") {
      return;
    }

    const updateSidebarHostPresence = () => {
      const nextValue = Boolean(
        document.querySelector('[data-sync-widget-sidebar-host="true"]'),
      );
      setSidebarHostPresent((previousValue) =>
        previousValue === nextValue ? previousValue : nextValue,
      );
    };

    updateSidebarHostPresence();

    const observer = new MutationObserver(updateSidebarHostPresence);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-sync-widget-sidebar-host"],
    });

    return () => observer.disconnect();
  }, [host]);

  if (host === "portal" && sidebarHostPresent) {
    return null;
  }

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
