"use client";

import { useCallback, useEffect, useState } from "react";

import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import { rolesByLocalLabel } from "@/app/lib/shared-drives/driveRowSharing";
import type { DriveRole } from "@/app/lib/shared-drives/roles";
import {
  isSharedDrivesUnavailable,
  listMyDriveMemberships,
} from "@/app/lib/tauri/sharedDrives";

const EMPTY: ReadonlyMap<string, DriveRole> = new Map();

/**
 * Roles for the shared drives synced on this device, keyed by local label.
 *
 * Drive rows come from `sync_paths` and roles from the membership listing, so
 * this is the join that lets a row say what the viewer can do in it. The key is
 * the local label, which both sides agree on: `folder_name` is
 * `sync_paths.label`, and so is a membership's `local_label`.
 *
 * Failures are swallowed to the empty map on purpose. A missing role costs a
 * badge detail — the row still says "Shared", which it knows from its own
 * `ownerSs58` — whereas surfacing a listing error would put a failure in front
 * of the user for a surface they did not ask for. A feature-off server is the
 * expected case, not an exception.
 */
export function useSharedDriveRoles(): ReadonlyMap<string, DriveRole> {
  const [roles, setRoles] = useState<ReadonlyMap<string, DriveRole>>(EMPTY);

  const load = useCallback(async () => {
    if (!SHARED_DRIVES_ENABLED) return;
    try {
      const memberships = await listMyDriveMemberships();
      setRoles(rolesByLocalLabel(memberships));
    } catch (err) {
      if (!isSharedDrivesUnavailable(err)) {
        console.warn("[useSharedDriveRoles] membership listing failed:", err);
      }
      setRoles(EMPTY);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return roles;
}
