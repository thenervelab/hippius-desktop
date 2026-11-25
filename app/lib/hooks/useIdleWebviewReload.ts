"use client";

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/** How often a long-lived page asks Rust whether to reload itself. */
export const IDLE_RELOAD_CHECK_MS = 5 * 60 * 1000;

/**
 * Input that shows someone is using the page. Pointer movement is left out:
 * a cursor passing over a window on its way elsewhere is not use.
 */
const INPUT_EVENTS = ["keydown", "pointerdown", "wheel"] as const;

/**
 * Whether the page is in the middle of something a reload would throw away:
 * an open dialog (the update dialog, a confirmation, a form).
 */
export function pageIsBusy(doc: Document): boolean {
  return doc.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]') !== null;
}

/**
 * Reload this webview when it has been out of use for hours.
 *
 * On Windows, WebView2 never frees the script of an event it has received, so
 * a window that stays open for days slowly grows; a reload gives that memory
 * back. Rust decides when (`webview_reload_due`: hidden or minimized for two
 * hours, or on Windows on screen without focus or input for six, no capture
 * in progress). The page reports how long it has had no input, adds the one
 * thing Rust cannot see, an open dialog, and otherwise waits for the next
 * check.
 */
export function useIdleWebviewReload(reload: () => void = () => window.location.reload()): void {
  useEffect(() => {
    let lastInput = Date.now();
    const onInput = () => {
      lastInput = Date.now();
    };
    for (const type of INPUT_EVENTS) {
      window.addEventListener(type, onInput, { capture: true, passive: true });
    }

    let checking = false;
    const interval = window.setInterval(() => {
      if (checking) return;
      checking = true;
      void invoke<boolean>("webview_reload_due", {
        // Clamped: a wall clock stepped back would send a negative count,
        // which the u64 on the Rust side refuses outright.
        idleMs: Math.max(0, Date.now() - lastInput),
      })
        .then((due) => {
          if (due && !pageIsBusy(document)) reload();
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, IDLE_RELOAD_CHECK_MS);

    return () => {
      window.clearInterval(interval);
      for (const type of INPUT_EVENTS) {
        window.removeEventListener(type, onInput, { capture: true });
      }
    };
  }, [reload]);
}

/** Mount point for pages that render no hooks of their own at the root. */
export function IdleWebviewReload(): null {
  useIdleWebviewReload();
  return null;
}
