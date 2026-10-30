"use client";

// The memberships behind "Shared with me", for the sections that list them
// (the Shared Drives page, which also reads them for its tab counts, and
// Settings). It reads the ONE memberships query every other surface reads
// (`sharedDriveMembershipsQueryOptions`), so leaving or joining a drive
// anywhere, which invalidates that query, updates these lists too.

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import { sharedDriveMembershipsQueryOptions } from "@/app/lib/hooks/useSharedDriveRoles";
import { isSharedDrivesUnavailable } from "@/app/lib/tauri/sharedDrives";
import { sharedWithMeDataFrom, type SharedWithMeData } from "./sharedWithMeState";

export interface DriveMemberships {
  data: SharedWithMeData;
  /** Fetch again, keeping the rows on screen while it runs. */
  reload: () => Promise<void>;
  /** The server turned the feature off mid-session: hide quietly. */
  markUnavailable: () => void;
}

/**
 * The drives shared with this account, when `enabled`. Asked again each
 * time a list mounts, so a page visit shows what the server says now. A
 * passive fetch: a failure is logged and settles as `error`, never a toast.
 */
export function useDriveMemberships(enabled = true): DriveMemberships {
  const on = SHARED_DRIVES_ENABLED && enabled;
  const { data, error, isError, isFetching, refetch } = useQuery({
    ...sharedDriveMembershipsQueryOptions,
    enabled: on,
    refetchOnMount: "always",
  });
  const [markedUnavailable, setMarkedUnavailable] = useState(false);

  const reload = useCallback(async () => {
    setMarkedUnavailable(false);
    await refetch();
  }, [refetch]);

  const markUnavailable = useCallback(() => setMarkedUnavailable(true), []);

  const state = useMemo(
    () =>
      sharedWithMeDataFrom({
        enabled: on,
        data,
        isError,
        isFetching,
        unavailable: isError && isSharedDrivesUnavailable(error),
        markedUnavailable,
      }),
    [on, data, isError, isFetching, error, markedUnavailable],
  );

  return { data: state, reload, markUnavailable };
}
