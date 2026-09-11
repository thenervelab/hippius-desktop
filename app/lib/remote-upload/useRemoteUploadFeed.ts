"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { listen } from "@tauri-apps/api/event";

import {
  applyRemoteUpload,
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
  const setUploads = useSetAtom(remoteUploadsAtom);

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
}
