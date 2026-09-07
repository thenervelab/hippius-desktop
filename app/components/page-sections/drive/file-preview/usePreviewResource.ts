"use client";

import { useEffect, useRef, useState } from "react";

import {
  abortError,
  isAbortReason,
  previewErrorMessage,
  readPreviewBytes,
} from "./previewBytes";

export type PreviewResourceState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

export type PreviewParser<T> = (
  bytes: Uint8Array,
  signal: AbortSignal,
) => T | Promise<T>;

export interface PreviewResourceOptions<T> {
  /**
   * Releases what the parsed data holds: object URLs, injected fonts, a
   * renderer's own archive handle. Called when the data is replaced, when the
   * component unmounts, and when a parse finishes *after* its request was
   * already cancelled — otherwise a slow parse of a file the user navigated
   * away from would leak everything it allocated.
   */
  dispose?: (data: T) => void;
}

/**
 * Load a file's bytes through Rust, parse them, and hold the result.
 *
 * This is the single lifecycle every byte-backed preview body uses, so the
 * guarantees below hold for all of them rather than being re-derived per
 * renderer:
 *
 *  - **Obsolete loads are abandoned.** Changing file (arrow keys, thumbnail
 *    rail) aborts the in-flight request before starting the next one.
 *  - **A late response cannot replace the current preview.** The result is
 *    dropped when its own controller has been aborted, so a slow 20 MB
 *    spreadsheet finishing after the user moved on never paints over the file
 *    now on screen.
 *  - **Resources are released on every exit path** — replacement, unmount, and
 *    the late-arrival path above.
 */
export function usePreviewResource<T>(
  localPath: string,
  maxBytes: number,
  parser: PreviewParser<T>,
  options: PreviewResourceOptions<T> = {},
): PreviewResourceState<T> {
  const [state, setState] = useState<PreviewResourceState<T>>({
    status: "loading",
  });
  // Held in a ref so a caller can pass an inline `dispose` without the effect
  // re-running (and therefore re-reading the file) on every render.
  const disposeRef = useRef(options.dispose);
  disposeRef.current = options.dispose;

  useEffect(() => {
    if (!localPath) {
      setState({ status: "error", message: "This file can't be previewed." });
      return;
    }

    const controller = new AbortController();
    let current: { data: T } | null = null;
    setState({ status: "loading" });

    void readPreviewBytes(localPath, maxBytes, controller.signal)
      .then((bytes) => parser(bytes, controller.signal))
      .then((data) => {
        if (controller.signal.aborted) {
          disposeRef.current?.(data);
          return;
        }
        current = { data };
        setState({ status: "ready", data });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isAbortReason(reason)) return;
        setState({ status: "error", message: previewErrorMessage(reason) });
      });

    return () => {
      controller.abort();
      if (current) disposeRef.current?.(current.data);
    };
  }, [localPath, maxBytes, parser]);

  return state;
}

export { abortError, isAbortReason, previewErrorMessage };
