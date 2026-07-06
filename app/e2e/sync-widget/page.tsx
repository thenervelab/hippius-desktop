"use client";

/**
 * E2E-only harness route for the sync widget.
 *
 * Mounts the REAL `SyncStatusHandler` → `SyncStatusDialog` in a real WKWebView
 * (driven on macOS by `tauri-plugin-webdriver`, see `e2e/`) and exposes a
 * backend-free driving bridge on `window.__e2ePushSyncFrame`. The WebdriverIO
 * smoke spec pushes recorded/scenario `SyncSnapshot` frames through it and
 * asserts the rendered DOM — exercising the actual renderer, CSS, and layout
 * that jsdom can't, with NO login / funded account / live hcfs-server.
 *
 * The driving hook installs ONLY when `NEXT_PUBLIC_E2E === "1"` (the env the
 * e2e build sets). In a normal production export the route renders an inert
 * placeholder and exposes nothing, so this is not a production control surface.
 */
import React, { useEffect } from "react";
import { Provider, createStore } from "jotai";

import SyncStatusHandler from "@/app/(pages)/SyncStatusHandler";
import { snapshotAtom } from "@/lib/hooks/useSyncSnapshot";
import { syncEngineHealthAtom } from "@/lib/store/syncAtoms";
import { type SyncSnapshot } from "@/lib/types/syncSnapshot";

const E2E_ENABLED = process.env.NEXT_PUBLIC_E2E === "1";

// One standalone store so the bridge can drive `snapshotAtom` from outside
// React (the spec calls the window hook, not a React event).
const e2eStore = createStore();
e2eStore.set(syncEngineHealthAtom, {
  status: "connected",
  last_check_time: 0,
  last_successful_check: 0,
  consecutive_failures: 0,
  server_version: null,
  error_message: null,
});

declare global {
  interface Window {
    /** Push one snapshot frame into the mounted widget. Installed only under
     *  the e2e build; the spec calls it via `browser.execute`. */
    __e2ePushSyncFrame?: (frame: SyncSnapshot) => void;
  }
}

function E2eBridge() {
  useEffect(() => {
    if (!E2E_ENABLED) return;
    window.__e2ePushSyncFrame = (frame: SyncSnapshot) => {
      e2eStore.set(snapshotAtom, frame);
    };
    // Signals the spec that the harness is ready to receive frames.
    document.body.setAttribute("data-e2e-sync-ready", "1");
    return () => {
      delete window.__e2ePushSyncFrame;
      document.body.removeAttribute("data-e2e-sync-ready");
    };
  }, []);
  return null;
}

export default function E2eSyncWidgetPage() {
  if (!E2E_ENABLED) {
    return (
      <div data-testid="e2e-disabled" style={{ padding: 24 }}>
        E2E harness disabled (build with NEXT_PUBLIC_E2E=1).
      </div>
    );
  }

  return (
    <Provider store={e2eStore}>
      <E2eBridge />
      <div
        data-testid="e2e-sync-host"
        style={{ position: "fixed", bottom: 16, right: 16 }}
      >
        <SyncStatusHandler host="portal" />
      </div>
    </Provider>
  );
}
