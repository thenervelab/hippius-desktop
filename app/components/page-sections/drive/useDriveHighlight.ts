"use client";

import { useEffect, useRef, useState } from "react";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  ENTRY_ATTRIBUTE,
  HIGHLIGHT_ATTRIBUTE,
  HIGHLIGHT_MS,
  HIGHLIGHT_RETRY_EVERY_MS,
  HIGHLIGHT_WAIT_MS,
  entryKey,
  isRequestedLevel,
  nextHighlightStep,
  stepForLocatedPage,
  type HighlightRequest,
} from "./highlightEntry";

interface Options {
  request: HighlightRequest | null;
  /** The request is done with (pointed out, or given up on). */
  onDone: () => void;
  /** The level on screen: its drive and folder, null when none is open. */
  level: { label: string | null; folder: string | null };
  /** The level has loaded (and no folder step is still pending). */
  ready: boolean;
  /** The level in the order it is shown (see `nextHighlightStep`). */
  ordered: readonly FormattedUserFile[];
  /** The rows rendered now; a new value means a new paint to look in. */
  rendered: unknown;
  serverPaged: boolean;
  paged: boolean;
  page: number;
  pageSize: number;
  setPage: (page: number) => void;
  /** Ask the listing again (a file written moments ago may be missing). */
  refresh: () => void;
  /** Which page of a server-paged level lists the file (Rust), or null. */
  locate: (name: string) => Promise<number | null>;
}

/** The rendered row or card for `key`, if it is painted. */
function findRendered(key: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const all = document.querySelectorAll<HTMLElement>(`[${ENTRY_ATTRIBUTE}]`);
  for (const el of all) {
    if (el.getAttribute(ENTRY_ATTRIBUTE) === key) return el;
  }
  return null;
}

const reducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Scroll the element to the middle of its scroller, highlight it for
 * `HIGHLIGHT_MS`, and move keyboard focus onto it.
 *
 * The files table's own "selection" is its bulk-select mode (checkboxes and
 * the selection action bar), so entering it to point one file out would
 * swap the toolbar under the user. Focus lands on the row's first control
 * instead (its name, which opens the file), which is where a keyboard user
 * continues from.
 */
export function pointOut(el: HTMLElement): () => void {
  el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  el.setAttribute(HIGHLIGHT_ATTRIBUTE, "");
  const control = el.querySelector<HTMLElement>(
    'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  );
  control?.focus({ preventScroll: true });
  const timer = setTimeout(() => el.removeAttribute(HIGHLIGHT_ATTRIBUTE), HIGHLIGHT_MS);
  return () => {
    clearTimeout(timer);
    el.removeAttribute(HIGHLIGHT_ATTRIBUTE);
  };
}

/**
 * Point out the file a "Show in folder" asked for, once its folder is on
 * screen: page to it, scroll it into view, highlight it. A file the listing
 * does not hold yet is looked for again on each refresh for
 * `HIGHLIGHT_WAIT_MS`, then quietly dropped.
 */
export function useDriveHighlight({
  request,
  onDone,
  level,
  ready,
  ordered,
  rendered,
  serverPaged,
  paged,
  page,
  pageSize,
  setPage,
  refresh,
  locate,
}: Options): void {
  // Re-runs the step after a wait even when the refresh brought back the
  // same rows (a listing that did not change keeps its identity).
  const [retryTick, setRetryTick] = useState(0);
  // When the level was first ready for this request: the wait starts there,
  // not at the click, since opening a remote folder takes its own time.
  const readySinceRef = useRef<{ request: HighlightRequest; at: number } | null>(null);
  const locatingRef = useRef(false);
  const latest = useRef({ onDone, setPage, refresh, locate, page });
  latest.current = { onDone, setPage, refresh, locate, page };

  // The highlight's own timer outlives the step that started it (the step
  // re-runs on every render); it is cleared when the page unmounts.
  const undoHighlightRef = useRef<(() => void) | null>(null);
  useEffect(() => () => undoHighlightRef.current?.(), []);

  const levelLabel = level.label;
  const levelFolder = level.folder;

  useEffect(() => {
    if (!request) return;
    const now = Date.now();
    if (now >= request.until) {
      latest.current.onDone();
      return;
    }
    if (!ready || !isRequestedLevel(request, { label: levelLabel, folder: levelFolder })) return;
    if (readySinceRef.current?.request !== request) readySinceRef.current = { request, at: now };
    const waitingFor = { ...request, until: Math.min(request.until, readySinceRef.current.at + HIGHLIGHT_WAIT_MS) };
    const step = nextHighlightStep(waitingFor, { ordered, serverPaged, paged, page, pageSize, now });

    const retryLater = (ask: boolean) => {
      const timer = setTimeout(() => {
        if (ask) latest.current.refresh();
        setRetryTick((t) => t + 1);
      }, HIGHLIGHT_RETRY_EVERY_MS);
      return () => clearTimeout(timer);
    };

    switch (step.kind) {
      case "give-up":
        latest.current.onDone();
        return;
      case "page":
        latest.current.setPage(step.page);
        return;
      case "show": {
        // After the paint: the row for a page just switched to is not in
        // the document until then.
        let cancelled = false;
        let cancelRetry: (() => void) | null = null;
        const frame = requestAnimationFrame(() => {
          if (cancelled) return;
          const el = findRendered(entryKey(step.file));
          if (!el) {
            // Listed but not painted (yet): look again shortly.
            cancelRetry = retryLater(false);
            return;
          }
          undoHighlightRef.current?.();
          undoHighlightRef.current = pointOut(el);
          latest.current.onDone();
        });
        return () => {
          cancelled = true;
          cancelAnimationFrame(frame);
          cancelRetry?.();
        };
      }
      case "locate": {
        if (locatingRef.current) return;
        locatingRef.current = true;
        let cancelled = false;
        let cancelRetry: (() => void) | null = null;
        latest.current
          .locate(request.name)
          .catch(() => null)
          .then((located) => {
            locatingRef.current = false;
            // Superseded while asking: the run that replaced this one found
            // a question in flight and stood back, so it is run again.
            if (cancelled) {
              setRetryTick((t) => t + 1);
              return;
            }
            const next = stepForLocatedPage(located, latest.current.page);
            if (next.kind === "page") latest.current.setPage(next.page);
            else cancelRetry = retryLater(true);
          });
        return () => {
          cancelled = true;
          cancelRetry?.();
        };
      }
      case "wait":
        return retryLater(true);
    }
  }, [request, ready, levelLabel, levelFolder, ordered, rendered, serverPaged, paged, page, pageSize, retryTick]);
}
