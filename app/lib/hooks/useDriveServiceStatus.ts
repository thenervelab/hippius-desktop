"use client";

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import type { DriveServiceStatus } from "@/app/components/page-sections/drive/service-status/driveStatusBannerState";

export const DRIVE_SERVICE_STATUS_QUERY_KEY = "driveServiceStatus";

/** While a plan is still being provisioned, follow it. */
const SETTLING_POLL_MS = 15_000;
/** Otherwise this is background information; it does not need to be fresh. */
const STALE_MS = 60_000;

/**
 * Drive's own state for the signed-in account.
 *
 * Rust fails this call quiet, so an outage leaves the page as it was
 * rather than putting an error in front of someone who came to do
 * something else. `pending` resolves on its own, so it is followed until
 * it does — the same cadence the console uses.
 */
export function useDriveServiceStatus() {
  const { polkadotAddress } = useWalletAuth();

  return useQuery<DriveServiceStatus>({
    queryKey: [DRIVE_SERVICE_STATUS_QUERY_KEY, polkadotAddress],
    queryFn: () =>
      invoke<DriveServiceStatus>("get_drive_service_status", {
        accountId: polkadotAddress,
      }),
    enabled: Boolean(polkadotAddress),
    staleTime: STALE_MS,
    refetchOnWindowFocus: false,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === "pending" ? SETTLING_POLL_MS : false,
  });
}
