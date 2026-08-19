/**
 * Pure view-state resolution for the home page's storage + plan cards and
 * the top-bar plan/credits chip. Kept I/O-free so the render branches are
 * unit-testable (`__tests__/storageOverviewState.test.ts`).
 *
 * The plan-vs-credits DECISION is made in Rust (`get_storage_overview`'s
 * `source` field) — these helpers only map that decision to view variants,
 * so every surface stays consistent by construction.
 */

import type { CapacitySource } from "@/app/lib/hooks/api/useStorageOverview";

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
  | "skeleton" // first load not settled yet — never flash "No active plan"
  | "error" // query failed — must not read as a confident zero (audit M-16)
  | "no-plan" // neither a subscription nor credits: no capacity to plot
  | "usage"; // the normal used-of-total bar (plan- or credits-backed)

export function getStorageOverviewView(input: {
  showSkeleton: boolean;
  isError: boolean;
  source: CapacitySource | undefined;
}): StorageOverviewView {
  if (input.showSkeleton) return "skeleton";
  if (input.isError) return "error";
  if (input.source === "subscription" || input.source === "credits")
    return "usage";
  return "no-plan";
}

/**
 * Footer caption naming the capacity source, so a credits-derived total is
 * never mistaken for a plan allowance.
 */
export function getCapacitySourceLabel(
  source: CapacitySource,
  planName: string | null | undefined,
): string {
  if (source === "subscription")
    return planName ? `${planName} plan` : "Active plan";
  if (source === "credits") return "Based on your credit balance";
  return "";
}

/** View variant for the plan card and the top-bar chip. */
export type PlanView =
  | "skeleton" // hold until the source decision has settled
  | "plan" // active subscription: name + price + allowance
  | "credits" // no subscription, positive balance: credits headline
  | "none"; // neither: "No active plan" + subscribe CTA

export function getPlanView(input: {
  showSkeleton: boolean;
  isError: boolean;
  source: CapacitySource | undefined;
}): PlanView {
  // An error still resolves the chip/card to "none" rather than a dedicated
  // error state: the storage card beside it already surfaces the failure,
  // and the chip has no room for error copy. The skeleton gate guarantees
  // we never show "none" while the answer is merely still loading.
  if (input.showSkeleton) return "skeleton";
  if (input.source === "subscription") return "plan";
  if (input.source === "credits") return "credits";
  return "none";
}

/**
 * Integer percent label, with "<1%" for tiny-but-nonzero usage so a
 * near-empty drive doesn't display a flat "0%" while bytes exist.
 */
export function formatPercentLabel(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

/** "12$/mo." style price label, mirroring the PageHeader chip's format. */
export function formatPlanPrice(amount: number, interval: string): string {
  return `${amount}$/${interval === "month" ? "mo." : interval}`;
}
