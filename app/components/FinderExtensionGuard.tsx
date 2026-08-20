"use client";

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

/**
 * Stable toast id so a re-mount (navigation) reuses the notice instead of
 * stacking duplicates, and so the focus re-check can dismiss the one it raised.
 */
const NUDGE_ID = "finder-extension-disabled";

/**
 * Surfaces the backend's Finder-extension enablement check.
 *
 * macOS installs a third-party Finder extension switched OFF: `HippiusFinder.appex`
 * ships inside the app and the system lists it, but until the user enables it
 * Finder never loads it, so right-clicking a synced file shows no "Share with
 * Hippius" item at all. Developer machines never saw this — `macos/dev-finder.sh`
 * enabled it once by bundle id, an election that outlives reinstalls — so the
 * feature looked shipped while being invisible to every fresh install.
 *
 * The decision lives in Rust (`finder_extension_state`, which asks Apple's
 * `FIFinderSyncController` rather than guessing); this component is presentation
 * only. It re-checks whenever the window regains focus, which is how the notice
 * clears itself the moment the user comes back from System Settings — Apple's own
 * documented flow for this API.
 *
 * Renders nothing. Mounted once in the main-window branch of `AppShell`.
 */
export default function FinderExtensionGuard() {
  // Whether our notice is currently on screen, so a focus re-check does not
  // raise a second one. Only the raise path consults it — the dismiss path
  // deliberately does not (see below).
  const showing = useRef(false);
  // Set when the user closes the notice. The extension is still off, so without
  // this the next focus would re-raise the toast they just dismissed; it returns
  // on the next app launch, the right cadence for a nag.
  //
  // Per-instance, so a re-mount forgets it. Kept that way on purpose: this
  // component does not re-mount in the main window (AppShell's branch changes
  // only for the tray-panel/e2e routes, which that window never navigates to,
  // and the guard sits above the auth-gated subtree), and module-level state
  // would leak between tests. The worst case is one extra nudge, never a
  // suppressed one — unlike `showing`, where the stale direction stranded a
  // permanent toast, which is why only that one is remount-proofed.
  const dismissed = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const check = () => {
      invoke<{ kind: string }>("finder_extension_state")
        .then((state) => {
          if (cancelled) return;

          if (state.kind !== "disabled") {
            // `unsupported` (every non-macOS platform, or a state macOS would not
            // report) is treated exactly like `enabled`: silence beats nagging on
            // an answer we can't stand behind.
            //
            // Dismiss UNCONDITIONALLY rather than only when this instance raised
            // the notice: a re-mount hands the new instance fresh refs, so a
            // `showing` gate would strand a notice a previous instance put up —
            // and with `duration: Infinity` it would never leave the screen.
            // Dismissing an id that isn't showing is a no-op.
            showing.current = false;
            toast.dismiss(NUDGE_ID);
            return;
          }

          if (dismissed.current || showing.current) return;
          showing.current = true;
          toast.warning("Turn on the Hippius Finder extension", {
            description:
              "macOS installs it switched off, so “Share with Hippius” is missing when you right-click a file. Enable Hippius under Finder in Extensions settings.",
            duration: Infinity,
            id: NUDGE_ID,
            action: {
              label: "Open Settings",
              onClick: () => {
                // Sonner removes the toast on an action click and — unlike its
                // close button — does NOT call `onDismiss` (2.0.7: the action
                // handler calls `deleteToast()` directly). So clear `showing`
                // here, or nothing ever does, and the `showing` check on the
                // raise path above suppresses the notice for the rest of the
                // session — after its own button, on its primary path.
                // Deliberately NOT `dismissed`: going to System Settings is not
                // "stop telling me", so if the user never flips the switch the
                // next focus check raises the notice again.
                showing.current = false;
                void invoke("open_finder_extension_settings").catch(() => {
                  toast.error("Could not open Extensions settings", {
                    description:
                      "Open System Settings › General › Login Items & Extensions, then enable Hippius under Finder.",
                  });
                });
              },
            },
            // Reached by a real dismissal only — the close button, a swipe, or
            // our own `toast.dismiss` above — never by the action button.
            onDismiss: () => {
              showing.current = false;
              dismissed.current = true;
            },
          });
        })
        .catch(() => {
          // A missing command or IPC failure must never block the app; the
          // backend already logs a disabled extension for support bundles.
        });
    };

    check();
    // Apple's documented pattern: re-check when the app becomes active again,
    // so enabling the extension in System Settings clears the notice on return.
    window.addEventListener("focus", check);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", check);
    };
  }, []);

  return null;
}
