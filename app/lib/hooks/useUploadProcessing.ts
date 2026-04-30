"use client";

import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { toast } from "sonner";

interface UploadProcessingPayload {
  active: boolean;
  pendingFiles: number;
}

/**
 * Stable Sonner toast ID. The same ID is reused across active=true
 * events so multiple updates within a single processing window
 * mutate the SAME toast (no stacking / flicker), and the
 * `toast.dismiss(...)` call when active=false targets exactly that
 * one toast.
 */
const UPLOAD_PROCESSING_TOAST_ID = "hcfs-upload-processing";

/**
 * Drives a single top-center Sonner toast off the Rust
 * `hcfs_upload_processing` event. Lifecycle:
 *  - `active: true`  → show / update `toast.loading(...)` with the
 *    pending-file count.
 *  - `active: false` → dismiss the toast.
 *
 * The toast intentionally has no auto-dismiss duration (it stays
 * visible until Rust signals the sync cycle has begun, at which
 * point the bottom-right sync widget takes over with real per-file
 * progress).
 *
 * No business logic — Rust owns lifecycle. This hook is a thin
 * Sonner adapter.
 */
export function useUploadProcessing() {
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;

    listen<UploadProcessingPayload>("hcfs_upload_processing", (e) => {
      if (cancelled) return;
      const { active, pendingFiles } = e.payload;
      if (active) {
        const label =
          pendingFiles === 0
            ? "Processing your files. Sync will start shortly…"
            : `Processing ${pendingFiles} ${pendingFiles === 1 ? "file" : "files"}. Sync will start shortly…`;
        toast.loading(label, {
          id: UPLOAD_PROCESSING_TOAST_ID,
          duration: Infinity,
        });
      } else {
        toast.dismiss(UPLOAD_PROCESSING_TOAST_ID);
      }
    })
      .then((u) => {
        if (cancelled) {
          u();
        } else {
          unsub = u;
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unsub?.();
      // Belt-and-suspenders: dismiss on unmount so a stuck toast
      // can't survive a re-mount (e.g. after a hot reload during
      // dev, or an auth-driven re-render).
      toast.dismiss(UPLOAD_PROCESSING_TOAST_ID);
    };
  }, []);
}
