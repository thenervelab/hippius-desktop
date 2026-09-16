"use client";

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

import { checkForUpdates } from "@/app/components/updater/checkForUpdates";

/**
 * The event Rust emits when its periodic check finds a version it has not
 * already mentioned this run. Mirrors `UPDATE_AVAILABLE_EVENT` in
 * `src-tauri/src/updates.rs`.
 */
export const UPDATE_AVAILABLE_EVENT = "update://available";

/**
 * Surface a release to an app that is already running.
 *
 * The app checked for updates at startup and when the user asked, and nowhere
 * else, so a copy left open for days never learned a release existed. The
 * timer lives in Rust (`spawn_background_update_checks`); this is the half
 * that shows it.
 *
 * It re-runs `checkForUpdates` rather than rendering from an event payload.
 * That path already owns the whole presentation — the notification row, the
 * install plan, the dialog, and the `currentUpdateObject` the dialog installs
 * from — so taking a shortcut here would be a second, subtly different
 * version of it. The cost is one extra manifest request an hour.
 *
 * Rust decides WHETHER to speak, and speaks once per version. Without that,
 * this would raise the dialog on every tick, for the same version, including
 * at somebody who has already dismissed it.
 */
export function useBackgroundUpdateChecks(): void {
  const running = useRef(false);

  useEffect(() => {
    let disposed = false;
    const pending = listen(UPDATE_AVAILABLE_EVENT, () => {
      // A check already in flight would open the dialog twice.
      if (running.current) return;
      running.current = true;
      // `true`: this is not a button press, so it must not block waiting for
      // an answer the way a user-initiated check does.
      // `checkForUpdates` handles its own failures, but `.finally()` re-raises
      // whatever it was chained onto: without the catch, an offline tick
      // becomes an unhandled rejection in the webview.
      void checkForUpdates(true)
        .catch(() => undefined)
        .finally(() => {
          running.current = false;
        });
    });

    return () => {
      disposed = true;
      void pending.then((unlisten) => {
        if (disposed) unlisten();
      });
    };
  }, []);
}
