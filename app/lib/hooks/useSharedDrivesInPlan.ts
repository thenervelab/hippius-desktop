"use client";

import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { planSupportsSharedDrives } from "@/app/lib/shared-drives/planEntitlement";

/**
 * Whether the account's plan includes shared drives.
 *
 * `undefined` while the overview is still loading, which the menu resolver
 * reads as "permitted": a control that appears a moment late is jank, but one
 * that appears and then vanishes reads as a bug. The server's
 * `shared_drives_not_entitled` gate is the authority either way.
 */
export function useSharedDrivesInPlan(): boolean | undefined {
  const { data: overview, isLoading } = useStorageOverview();
  if (isLoading && !overview) return undefined;
  // The CODE, never the display name: a marketing label changes without a
  // release and a gate written against it stops matching silently. A missing
  // `plan` object is the free tier (`null`); a plan whose code the rail did
  // not report is unknown, and `planSupportsSharedDrives` leaves that to the
  // server rather than refusing it here.
  return planSupportsSharedDrives(overview?.plan ? (overview.plan.code ?? "") : null);
}
