"use client";

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

/** How often a long-lived page asks Rust whether to reload itself. */
export const IDLE_RELOAD_CHECK_MS = 5 * 60 * 1000;

/**
 * Input that shows someone is using the page. Pointer movement is left out:
 * a cursor passing over a window on its way elsewhere is not use.
 */
const INPUT_EVENTS = ["keydown", "pointerdown", "wheel"] as const;

/**
 * Module-level, not a default parameter written inline: an inline default is
 * a new function on every render, which re-ran the effect below on every
 * render of the host page and reset its interval.
 */
const reloadPage = () => window.location.reload();

/** Input types that hold text the user typed; a checkbox's value is not a draft. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

/**
 * Whether the focused element holds text the user has typed and not sent (a
 * comment draft, the chat composer, a search box). Only the focused element
 * counts: a filled field the user left is a value the page keeps elsewhere.
 */
function hasUnsentText(doc: Document): boolean {
  const el = doc.activeElement;
  if (el instanceof HTMLTextAreaElement) return el.value !== "";
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type) && el.value !== "";
  const editable = el?.closest('[contenteditable=""], [contenteditable="true"]');
  return (editable?.textContent ?? "") !== "";
}

/**
 * Whether a reload would throw away something on the page: an open dialog (a
 * confirmation, a form) or unsent text in the focused field. A dialog marked
 * `data-reload-safe` does not count: the update dialog marks itself so while
 * nothing is downloading, because a reload re-runs the startup check that
 * opens it again.
 */
export function pageIsBusy(doc: Document): boolean {
  const open = doc.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
  const dialog = Array.from(open).some((d) => !d.hasAttribute("data-reload-safe"));
  return dialog || hasUnsentText(doc);
}

/**
 * Reload this webview when it has been out of use for hours.
 *
 * On Windows, WebView2 never frees the script of an event it has received, so
 * a window that stays open for days slowly grows; a reload gives that memory
 * back. Rust decides when (`webview_reload_due`: hidden or minimized for two
 * hours, or on Windows on screen with no input for six, nothing busy). The
 * page reports what only it can see, how long it has had no input and whether
 * it holds a dialog or unsent text, and reloads when told to unless the user came
 * back while it was asking.
 */
export function useIdleWebviewReload(reload: () => void = reloadPage): void {
  // A ref, so a re-render of the host page never counts as input.
  const lastInput = useRef<number | null>(null);

  useEffect(() => {
    lastInput.current ??= Date.now();
    const onInput = () => {
      lastInput.current = Date.now();
    };
    for (const type of INPUT_EVENTS) {
      window.addEventListener(type, onInput, { capture: true, passive: true });
    }

    let checking = false;
    const interval = window.setInterval(() => {
      if (checking) return;
      checking = true;
      const askedAt = Date.now();
      const since = lastInput.current ?? askedAt;
      void invoke<boolean>("webview_reload_due", {
        // Clamped: a wall clock stepped back would send a negative count,
        // which the u64 on the Rust side refuses outright.
        idleMs: Math.max(0, askedAt - since),
        pageBusy: pageIsBusy(document),
      })
        .then((due) => {
          const cameBack = (lastInput.current ?? 0) > askedAt;
          if (due && !cameBack && !pageIsBusy(document)) reload();
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
