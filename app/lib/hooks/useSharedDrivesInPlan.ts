"use client";

import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";

/**
 * Whether the account's plan lets it share drives and folders.
 *
 * Rust decides (`billing/sharing_entitlement.rs`, sent as `canShareDrives`
 * on the storage overview): Plus, Max and Scale can, Free and Starter
 * cannot. This hook only reads the answer; it never looks at the plan code.
 *
 * - `undefined` while the overview is still loading, so a surface can show
 *   a placeholder instead of flashing the upgrade prompt.
 * - `true` when the overview could not be loaded at all: a plan that cannot
 *   be read blocks nothing, and the server's `shared_drives_not_entitled`
 *   refusal is still the authority (it shows the same upgrade prompt).
 */
export function useSharedDrivesInPlan(): boolean | undefined {
  const { data: overview, isError } = useStorageOverview();
  if (overview) return overview.canShareDrives !== false;
  if (isError) return true;
  return undefined;
}
