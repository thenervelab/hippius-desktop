"use client";

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/** How often a long-lived page asks Rust whether to reload itself. */
export const IDLE_RELOAD_CHECK_MS = 5 * 60 * 1000;

/**
 * Whether the page is in the middle of something a reload would throw away:
 * an open dialog (the update dialog, a confirmation, a form).
 */
export function pageIsBusy(doc: Document): boolean {
  return doc.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]') !== null;
}

/**
 * Reload this webview when it has been out of sight for hours.
 *
 * On Windows, WebView2 never frees the script of an event it has received, so
 * a window that stays open for days slowly grows; a reload gives that memory
 * back. Rust decides when (`webview_reload_due`: hidden or minimized for two
 * hours, no capture in progress); the page only adds the one thing Rust
 * cannot see, an open dialog, and otherwise waits for the next check.
 */
export function useIdleWebviewReload(reload: () => void = () => window.location.reload()): void {
  useEffect(() => {
    let checking = false;
    const interval = window.setInterval(() => {
      if (checking) return;
      checking = true;
      void invoke<boolean>("webview_reload_due")
        .then((due) => {
          if (due && !pageIsBusy(document)) reload();
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, IDLE_RELOAD_CHECK_MS);
    return () => window.clearInterval(interval);
  }, [reload]);
}

/** Mount point for pages that render no hooks of their own at the root. */
export function IdleWebviewReload(): null {
  useIdleWebviewReload();
  return null;
}
