import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

/**
 * The app version is global and immutable for the process lifetime, but the
 * `@tauri-apps/api/app` `getVersion()` binding does NOT cache — each call is a
 * fresh IPC round-trip. A list of N components each calling it (e.g. one per
 * notification row) fired N identical IPCs. Memoize a single promise at module
 * scope so it resolves once per session and every caller shares the result.
 */
let versionPromise: Promise<string> | null = null;

function loadAppVersion(): Promise<string> {
  if (!versionPromise) {
    versionPromise = getVersion().catch((err: unknown) => {
      console.warn("[useAppVersion] Failed to get app version:", err);
      // Reset so a later mount can retry rather than caching the failure.
      versionPromise = null;
      return "";
    });
  }
  return versionPromise;
}

/**
 * Returns the app version string, fetched once per session and shared across
 * all callers. Empty string until resolved (or on failure).
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState<string>("");
  useEffect(() => {
    let active = true;
    void loadAppVersion().then((v) => {
      if (active) setVersion(v);
    });
    return () => {
      active = false;
    };
  }, []);
  return version;
}
