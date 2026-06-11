"use client";

import React, { useEffect, useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAtom, useSetAtom } from "jotai";

import SyncStatusDialog from "./SyncStatusDialog";
import { useSyncSnapshot } from "../lib/hooks/useSyncSnapshot";
import { registerTauriListeners } from "../lib/utils/tauriListeners";
import { syncWidgetMinimizedAtom } from "../lib/store/syncAtoms";
import { sidebarCollapsedAtom } from "@/app/components/sidebar/sideBarAtoms";
import cn from "@/app/lib/utils/cn";

interface SyncStatusHandlerProps {
  host?: "portal" | "sidebar";
  /**
   * Sidebar collapse state, passed only by the sidebar host. When the sidebar
   * is collapsed the widget always renders its compact circular form so it
   * stays visible in the narrow rail instead of disappearing.
   */
  collapsed?: boolean;
}

/**
 * Sync status widget handler.
 *
 * All *visibility* and latching logic is owned by Rust (via widget_visible
 * and widget_state on the snapshot); this component renders based on those
 * fields. It additionally owns one piece of pure-UI state — whether the
 * widget is collapsed into its compact circular form — which is the OR of the
 * frontend {@link syncWidgetMinimizedAtom} (the ✕ icon) and the sidebar's own
 * collapsed state. Either trigger shows {@link SyncStatusMini}; clicking the
 * ring expands back to the full card (and uncollapses the sidebar).
 */
const SyncStatusHandler: React.FC<SyncStatusHandlerProps> = ({
  host = "portal",
  collapsed = false,
}) => {
  const snapshot = useSyncSnapshot();
  const [minimized, setMinimized] = useAtom(syncWidgetMinimizedAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
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

  // Clicking ✕ no longer dismisses the widget in Rust; it minimizes into the
  // compact ring (still reachable), mirroring the design's "collapse, don't
  // hide" intent. Genuine teardown still flows through sp_dismiss_sync_widget
  // (the hcfs_sync_stopped listener above).
  const handleClose = useCallback(() => {
    setMinimized(true);
  }, [setMinimized]);

  // Clicking the compact ring restores the full card. It also uncollapses the
  // sidebar so the expanded widget has room to render where it lives.
  const handleExpand = useCallback(() => {
    setMinimized(false);
    setSidebarCollapsed(false);
  }, [setMinimized, setSidebarCollapsed]);

  // A brand-new sync session (new startedAt) re-opens the full widget, so a
  // prior minimize doesn't permanently shrink every future sync. This mirrors
  // the old dismiss→reappear behavior now that ✕ minimizes instead of hides.
  const previousStartedAtRef = useRef(snapshot.startedAt);
  useEffect(() => {
    if (snapshot.startedAt !== previousStartedAtRef.current) {
      previousStartedAtRef.current = snapshot.startedAt;
      // Only write when actually collapsed — an unconditional setMinimized
      // would schedule a redundant Jotai update on every session change.
      if (snapshot.startedAt !== null && minimized) {
        setMinimized(false);
      }
    }
  }, [snapshot.startedAt, minimized, setMinimized]);

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

  const minified = collapsed || minimized;

  const dialog = (
    <SyncStatusDialog
      snapshot={snapshot}
      open={snapshot.widgetVisible}
      minimized={minified}
      onClose={handleClose}
      onExpand={handleExpand}
      expandOrigin={host === "sidebar" ? "bottom-left" : "bottom-right"}
    />
  );

  // The full 239px card is wider than the padded sidebar, so the sidebar host
  // bleeds it out with -mx-3 (as before). The 30px ring needs no bleed — it
  // aligns under the profile avatar. The portal host (bottom-right overlay)
  // never wants either margin. Returning the wrapper from here — rather than
  // the footer — keeps an empty flex slot (and its gap) out of the layout when
  // the widget is hidden.
  if (host === "sidebar") {
    return <div className={cn(minified ? "" : "-mx-3")}>{dialog}</div>;
  }

  return dialog;
};

export default SyncStatusHandler;
