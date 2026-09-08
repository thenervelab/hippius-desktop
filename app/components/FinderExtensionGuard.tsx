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
 * Sequoia 15.2+ / Tahoe list Finder Sync under **File Providers**, not Finder.
 * The Finder category is Apple's Quick Actions (Rotate Left, Markup, …), so
 * telling the user "enable Hippius under Finder" sends them to a list that
 * can never contain us.
 */
const NUDGE_DESCRIPTION =
  "macOS leaves it switched off, so “Share with Hippius” is missing when you right-click a file. Choose Enable, or turn Hippius on under File Providers (not Finder) in Extensions settings.";

/**
 * Must cover the case where Hippius is in the pane at ALL, because it often is
 * not: macOS registers an extension only after LaunchServices has built a bundle
 * record for the containing app, and when that never happens the extension is in
 * no list, no pane and no `pluginkit` query. Telling that user to "enable
 * Hippius in Settings" is advice they cannot follow.
 */
const SETTINGS_FALLBACK_DESCRIPTION =
  "Open System Settings › General › Login Items & Extensions › File Providers, then turn on Hippius. If Hippius is not listed there at all, restart your Mac — macOS sometimes fails to register the extension, and a restart makes it re-scan.";

/**
 * Deliberately does not promise the menu item is there *now*. Finder loads a
 * newly elected extension on its own schedule — `macos/dev-finder.sh` follows
 * the same two pluginkit verbs with `killall Finder` to force it. We do not do
 * that to a user: relaunching Finder closes every open window and tab, which is
 * a real cost to spare them a short wait.
 */
const ENABLED_DESCRIPTION = "Right-click a file in your Hippius folder to share it. It can take a moment to appear.";

/** Wire value of the "never ask again" preference, matched by Rust. */
const PREFERENCE_UNWANTED = "unwanted";

/**
 * Surfaces the backend's Finder-extension enablement check.
 *
 * Rust switches the extension on itself — on first run and again after an
 * app or macOS update, the way MEGAsync and ownCloud do — so this notice is a
 * FALLBACK for the cases that election cannot reach: a second registered copy
 * of the app, an MDM profile, LaunchServices never having recorded the bundle.
 *
 * The decision lives in Rust (`finder_extension_state`, which asks Apple's
 * `FIFinderSyncController` and honours the user's stored preference); this
 * component is presentation only.
 *
 * It raises the notice AT MOST ONCE PER LAUNCH. The re-check on window focus
 * exists so the notice clears itself the moment the user comes back from
 * System Settings (Apple's documented flow) — it never raises it again. The
 * earlier version re-raised on every focus while the state read `disabled`,
 * which a user who had just pressed Enable experienced as a notice that
 * "doesn't go away".
 *
 * Renders nothing. Mounted once in the main-window branch of `AppShell`.
 */
export default function FinderExtensionGuard() {
  // Whether our notice is currently on screen, so a stray second mount-check
  // does not raise a second one. Only the raise path consults it — the dismiss
  // path deliberately does not (see below).
  const showing = useRef(false);
  // Set once this launch has had its say: the user closed the notice, chose
  // "Don't ask again", or an Enable was verified. Nothing raises it again
  // until the next launch, which is the right cadence for a nag.
  //
  // Per-instance, so a re-mount forgets it. This component does not re-mount
  // in the main window (AppShell's branch changes only for the tray-panel/e2e
  // routes), and module-level state would leak between tests. The worst case
  // is one extra nudge, never a suppressed one.
  const dismissed = useRef(false);

  useEffect(() => {
    let cancelled = false;

    /**
     * Turn the extension on, falling back to the system pane.
     *
     * Rust registers it with the system and elects it (`pluginkit -a` then
     * `-e use`). That covers the case sending the user to Settings never
     * could: an extension macOS never registered is in no pane at all.
     *
     * Only an explicit `enabled` counts as success. `unsupported` means the
     * backend could not verify the result — the pluginkit calls may well have
     * worked, but claiming success on an unverified answer is the one outcome
     * worse than an extra trip to Settings.
     */
    const enableThenFallback = async () => {
      try {
        const state = await invoke<{ kind: string }>("enable_finder_extension");
        if (state.kind === "enabled") {
          // A verified enable is this launch's answer. If macOS later reads
          // the switch as off again, the next launch re-elects and, failing
          // that, asks again — not this session.
          dismissed.current = true;
          toast.dismiss(NUDGE_ID);
          toast.success("Finder extension enabled", { description: ENABLED_DESCRIPTION });
          return;
        }
      } catch {
        // An older backend without the command, or a build with no extension
        // to register. Either way the pane is still worth offering.
      }

      try {
        await invoke("open_finder_extension_settings");
      } catch {
        toast.error("Could not open Extensions settings", {
          description: SETTINGS_FALLBACK_DESCRIPTION,
        });
      }
    };

    /** Record that the user never wants this notice; Rust reports `unsupported` from then on. */
    const neverAskAgain = () => {
      dismissed.current = true;
      invoke("set_finder_extension_preference", { preference: PREFERENCE_UNWANTED }).catch(() => {
        // Storing the preference is best-effort; the session is silenced
        // regardless, and an unwritten preference costs one nudge next launch.
      });
    };

    const raise = () => {
      showing.current = true;
      toast.warning("Turn on the Hippius Finder extension", {
        description: NUDGE_DESCRIPTION,
        duration: Infinity,
        id: NUDGE_ID,
        action: {
          label: "Enable",
          onClick: () => {
            // Sonner removes the toast on an action click and — unlike its
            // close button — does NOT call `onDismiss` (2.0.7: the action
            // handler calls `deleteToast()` directly). So clear `showing`
            // here, or nothing ever does.
            showing.current = false;
            void enableThenFallback();
          },
        },
        cancel: {
          label: "Don't ask again",
          onClick: () => {
            showing.current = false;
            neverAskAgain();
          },
        },
        // Reached by a real dismissal only — the close button, a swipe, or
        // our own `toast.dismiss` above — never by the two buttons.
        onDismiss: () => {
          showing.current = false;
          dismissed.current = true;
        },
      });
    };

    /**
     * Ask the backend, then either clear the notice or (on the mount check
     * only) raise it.
     */
    const check = (trigger: "mount" | "focus") => {
      invoke<{ kind: string }>("finder_extension_state")
        .then((state) => {
          if (cancelled) return;

          if (state.kind !== "disabled") {
            // `unsupported` (every non-macOS platform, a state macOS would not
            // report, or a user who chose "Don't ask again") is treated exactly
            // like `enabled`: silence beats nagging on an answer we can't stand
            // behind.
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

          // A focus re-check only ever clears; raising belongs to the mount
          // check, so one launch asks once.
          if (trigger === "focus") return;
          if (dismissed.current || showing.current) return;
          raise();
        })
        .catch(() => {
          // A missing command or IPC failure must never block the app; the
          // backend already logs a disabled extension for support bundles.
        });
    };

    check("mount");
    // Apple's documented pattern: re-check when the app becomes active again,
    // so enabling the extension in System Settings clears the notice on return.
    const onFocus = () => check("focus");
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return null;
}
