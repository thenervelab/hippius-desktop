/**
 * Dev-only override for the home storage/plan cards and the top-bar chip,
 * so plan/credits/none states can be tested without a real subscription
 * (mirrors the mobile app's `devStorageUsage` pattern).
 *
 * Usage — in a DEV build (`pnpm tauri:dev`), from the webview devtools:
 *
 *   // Simulate an active subscription at 85% usage:
 *   localStorage["hippius:dev-storage-overview"] = JSON.stringify({
 *     source: "subscription",
 *     plan: { name: "Pro", amount: 12, interval: "month", storageBytes: 1e12 },
 *     usedBytes: 850e9, totalBytes: 1e12,
 *   });
 *
 *   // Simulate credits-only (no plan):
 *   localStorage["hippius:dev-storage-overview"] = JSON.stringify({
 *     source: "credits", creditsHip: "12.5",
 *     usedBytes: 100e9, totalBytes: 400e9,
 *   });
 *
 *   // Simulate no plan + no credits:
 *   localStorage["hippius:dev-storage-overview"] = JSON.stringify({ source: "none", usedBytes: 0, totalBytes: 0, percent: 0 });
 *
 *   // Back to real data:
 *   delete localStorage["hippius:dev-storage-overview"];
 *
 * Then reload (⌘R) — the override merges over the real IPC response in the
 * hook's `select`. Fields you omit keep their real values; `percent` is
 * recomputed from used/total when not given explicitly. A production build
 * compiles this to a hard no-op.
 */

import type { StorageOverview } from "@/app/lib/hooks/api/useStorageOverview";

export const STORAGE_OVERVIEW_DEV_KEY = "hippius:dev-storage-overview";

/**
 * Merge a partial override over the real response. Pure so it's testable;
 * percent is recomputed (clamped) when the override changes bytes without
 * pinning percent itself.
 */
export function applyStorageOverviewDevOverride(
  data: StorageOverview,
  override: Partial<StorageOverview> | null,
): StorageOverview {
  if (!override) return data;
  const merged = { ...data, ...override };
  if (override.percent === undefined) {
    merged.percent =
      merged.totalBytes > 0
        ? Math.min(Math.max((merged.usedBytes / merged.totalBytes) * 100, 0), 100)
        : 0;
  }
  return merged;
}

/** Read the override from localStorage; null in production or when unset/invalid. */
export function readStorageOverviewDevOverride(): Partial<StorageOverview> | null {
  if (process.env.NODE_ENV === "production") return null;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_OVERVIEW_DEV_KEY);
    return raw ? (JSON.parse(raw) as Partial<StorageOverview>) : null;
  } catch {
    return null;
  }
}
