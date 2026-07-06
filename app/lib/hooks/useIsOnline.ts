"use client";

import { useSyncExternalStore } from "react";

/**
 * Reactive `navigator.onLine` as a boolean.
 *
 * The desktop app's reads all go through local Tauri IPC, which does NOT throw
 * when the machine is offline (a Rust disk walk / cached indexer read still
 * resolves), so React Query never surfaces an error on its own. This hook is
 * the explicit offline signal the UI uses instead — see `OfflineBanner`.
 *
 * `navigator.onLine === false` is the reliable direction we care about: when
 * the OS reports no connection it is genuinely offline. (`true` only means a
 * link exists, not that the internet is reachable — good enough for a banner.)
 */
function subscribe(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getSnapshot() {
  return navigator.onLine;
}

// Assume online during SSR / before hydration so the banner never flashes on
// first paint.
function getServerSnapshot() {
  return true;
}

export function useIsOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export default useIsOnline;
