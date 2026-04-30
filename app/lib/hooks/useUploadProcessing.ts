"use client";

import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { toast } from "sonner";

/**
 * Stable Sonner toast ID. The IPC call sites
 * (`useFilesUpload/index.ts` and
 * `app/components/page-sections/files/upload-files-flow/index.tsx`)
 * SHOW the loading toast with this ID; this hook is responsible for
 * DISMISSING it when Rust signals the sync cycle has actually started
 * (i.e. the upload-processing window is over).
 *
 * Sharing one ID across "show" and "dismiss" sites prevents the
 * stacked-toasts UX bug where a separate "Processing N files…" toast
 * would briefly appear alongside the IPC site's "Adding codex.dmg…"
 * toast.
 */
export const UPLOAD_PROCESSING_TOAST_ID = "hcfs-upload-processing";

interface UploadProcessingPayload {
  active: boolean;
  pendingFiles: number;
}

/**
 * Listens to `hcfs_upload_processing` and dismisses the IPC-site
 * loading toast (`UPLOAD_PROCESSING_TOAST_ID`) when Rust signals
 * `active: false` — i.e. the sync cycle for the user's upload has
 * begun and the bottom-right widget now has real per-file data.
 *
 * No business logic — Rust owns lifecycle. This hook is a pure
 * dismiss-on-event adapter. We deliberately do NOT show a toast on
 * `active: true` — that's the IPC call site's job (it has the
 * filename / batch count for the toast text).
 */
export function useUploadProcessing() {
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;

    listen<UploadProcessingPayload>("hcfs_upload_processing", (e) => {
      if (cancelled) return;
      if (!e.payload.active) {
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
      // can't survive a hot reload during dev or auth-driven re-render.
      toast.dismiss(UPLOAD_PROCESSING_TOAST_ID);
    };
  }, []);
}
