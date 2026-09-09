"use client";

import { useEffect } from "react";
import { useAtom } from "jotai";
import { listen } from "@tauri-apps/api/event";

import {
  applyRemoteUpload,
  pruneRemoteUploads,
  REMOTE_UPLOAD_LINGER_MS,
  remoteUploadsAtom,
  type RemoteUploadProgress,
} from "./remoteUploadFeed";

/**
 * Keep {@link remoteUploadsAtom} in step with Rust.
 *
 * Mounted once at the app root, beside the sync snapshot listener — a
 * per-surface listener would mean the rows appear or vanish depending on
 * which page is open, and the widget is global.
 */
export function useRemoteUploadFeedListener() {
  const [uploads, setUploads] = useAtom(remoteUploadsAtom);

  useEffect(() => {
    let cancelled = false;
    const unlisten = listen<RemoteUploadProgress>("remote_upload_progress", (event) => {
      if (cancelled) return;
      setUploads((current) => applyRemoteUpload(current, event.payload));
    });
    return () => {
      cancelled = true;
      void unlisten.then((off) => off());
    };
  }, [setUploads]);

  // Terminal rows linger so a fast upload does not flash and vanish, then
  // are swept. The timer only runs while there is something to sweep.
  const hasRows = Object.keys(uploads).length > 0;
  useEffect(() => {
    if (!hasRows) return;
    const timer = setInterval(() => {
      setUploads((current) => {
        const next = pruneRemoteUploads(current);
        // Returning the same object when nothing changed keeps this from
        // re-rendering every consumer on each tick.
        return Object.keys(next).length === Object.keys(current).length ? current : next;
      });
    }, REMOTE_UPLOAD_LINGER_MS);
    return () => clearInterval(timer);
  }, [hasRows, setUploads]);
}
