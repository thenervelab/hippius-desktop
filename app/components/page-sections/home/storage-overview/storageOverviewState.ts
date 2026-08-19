/**
 * Pure view-state resolution for the home page's simple storage card.
 * Kept I/O-free so the render branches are unit-testable
 * (`__tests__/storageOverviewState.test.ts`).
 */

/** Mirrors the mobile app's usage thresholds (`usageThresholds.ts`). */
export const USAGE_WARN_PERCENT = 80;
export const USAGE_CRITICAL_PERCENT = 95;

export type UsageTone = "ok" | "warn" | "critical";

/** Bar/percent tone by fullness: brand → amber at 80% → red at 95%. */
export function getUsageTone(percent: number): UsageTone {
  if (percent >= USAGE_CRITICAL_PERCENT) return "critical";
  if (percent >= USAGE_WARN_PERCENT) return "warn";
  return "ok";
}

export type StorageOverviewView =
  | "skeleton" // first load not settled yet
  | "error" // query failed — must not read as a confident zero (audit M-16)
  | "no-plan" // no active subscription: no capacity to plot
  | "usage"; // the normal used-of-total bar

export function getStorageOverviewView(input: {
  showSkeleton: boolean;
  isError: boolean;
  hasPlan: boolean;
}): StorageOverviewView {
  if (input.showSkeleton) return "skeleton";
  if (input.isError) return "error";
  if (!input.hasPlan) return "no-plan";
  return "usage";
}

/**
 * Integer percent label, with "<1%" for tiny-but-nonzero usage so a
 * near-empty drive doesn't display a flat "0%" while bytes exist.
 */
export function formatPercentLabel(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}
