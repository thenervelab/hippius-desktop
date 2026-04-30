"use client";

import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { useSetAtom } from "jotai";
import {
  uploadProcessingAtom,
  DEFAULT_UPLOAD_PROCESSING_STATE,
  type UploadProcessingState,
} from "@/lib/global-atoms/uploadProcessingAtoms";

/**
 * Listens to `hcfs_upload_processing` and mirrors the payload into
 * `uploadProcessingAtom`. The atom drives `<UploadProcessingBanner />`.
 *
 * No business logic — Rust owns lifecycle. This hook is a pure mirror.
 * On unmount we reset the atom so a stale "active: true" cannot leak
 * across remounts (the Rust side will re-emit on next event anyway).
 */
export function useUploadProcessing() {
  const setState = useSetAtom(uploadProcessingAtom);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;

    listen<UploadProcessingState>("hcfs_upload_processing", (e) => {
      if (cancelled) return;
      setState(e.payload);
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
      // Reset on unmount so the next session starts clean.
      setState(DEFAULT_UPLOAD_PROCESSING_STATE);
    };
  }, [setState]);
}
