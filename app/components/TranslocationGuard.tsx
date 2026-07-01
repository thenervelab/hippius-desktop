"use client";

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

/**
 * Surfaces the backend's Gatekeeper App Translocation detection.
 *
 * When macOS launches a quarantined copy of Hippius from outside
 * `/Applications` (e.g. straight from a mounted DMG), it runs from a
 * randomized read-only path and refuses to remember folder permissions — the
 * "allow access to your Documents folder" prompt then reappears on every
 * launch. The detection itself lives in Rust (`is_app_translocated`); this
 * component is presentation only: it asks once on mount and, if translocated,
 * shows a persistent notice telling the user how to stop the re-prompting.
 *
 * Renders nothing. Mounted once in the main-window branch of `AppShell`.
 */
export default function TranslocationGuard() {
  // React mounts effects twice under StrictMode in dev; the ref makes the
  // one-shot check idempotent so the notice can't double-fire.
  const checked = useRef(false);

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;

    invoke<boolean>("is_app_translocated")
      .then((translocated) => {
        if (!translocated) return;
        toast.warning("Move Hippius to your Applications folder", {
          description:
            "Hippius is running from a temporary location, so macOS keeps re-asking for folder access. Quit Hippius, drag it into Applications, then reopen it.",
          duration: Infinity,
          // Stable id so a re-mount (navigation) reuses the same toast instead
          // of stacking duplicates.
          id: "app-translocation-warning",
        });
      })
      .catch(() => {
        // A missing command or IPC failure must never block the app; the
        // backend already logs translocation for support bundles.
      });
  }, []);

  return null;
}
